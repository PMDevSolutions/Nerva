import type { Context, MiddlewareHandler } from 'hono';

/**
 * Tenant resolution middleware.
 *
 * Resolves the tenant for each request from up to three sources, in the
 * configured order, and stores it on the Hono context under `tenant`:
 *
 * - `jwt`: a claim on the verified JWT payload (requires `hono/jwt` or
 *   equivalent auth middleware mounted BEFORE this one, so `jwtPayload` is
 *   already on the context). The claim is signed, so it cannot be spoofed —
 *   this is the default first source.
 * - `subdomain`: the label in front of `baseDomain`
 *   (`acme.api.example.com` → slug `acme`).
 * - `header`: an `X-Tenant-ID` header. Anyone can set a header, so only
 *   trust this source for service-to-service traffic behind a gateway that
 *   strips it from external requests, or combine it with authentication
 *   that verifies tenant membership in `lookupTenant`.
 *
 * Resolution alone selects WHICH tenant the request is for; the isolation
 * guarantees come from scoping every query (./row-scope.ts or
 * ./schema-scope.ts) and from the database policies (RLS / search_path).
 */

export type TenantSource = 'jwt' | 'subdomain' | 'header';

export interface TenantRef {
  source: TenantSource;
  /** Tenant slug (subdomain source) or tenant id (header / JWT claim). */
  value: string;
}

export interface TenantResolverOptions<TTenant> {
  /**
   * Map a resolved reference to a tenant, or null/undefined when it does not
   * exist. Typically a (cached) lookup against the `tenants` table. This is
   * also the place to verify that the authenticated user belongs to the
   * tenant when resolution and authentication use different sources.
   */
  lookupTenant: (ref: TenantRef, c: Context) => Promise<TTenant | null | undefined>;
  /** Sources to try, in priority order. Default: `['jwt', 'subdomain', 'header']`. */
  sources?: readonly TenantSource[];
  /** Base domain for the subdomain source, e.g. `api.example.com`. Without it the subdomain source never matches. */
  baseDomain?: string;
  /** Header for the header source. Default: `X-Tenant-ID`. */
  headerName?: string;
  /** JWT payload claim holding the tenant id. Default: `tenant_id`. */
  jwtClaim?: string;
}

/** Context Variables provided by {@link tenantResolver}, for typing Hono apps:
 * `new Hono<{ Variables: TenantVariables<Tenant> }>()`. */
export interface TenantVariables<TTenant> {
  tenant: TTenant;
}

const DEFAULT_SOURCES: readonly TenantSource[] = ['jwt', 'subdomain', 'header'];
const DEFAULT_HEADER_NAME = 'X-Tenant-ID';
const DEFAULT_JWT_CLAIM = 'tenant_id';
const TENANT_CONTEXT_KEY = 'tenant';

function subdomainOf(c: Context, baseDomain: string | undefined): string | undefined {
  if (!baseDomain) return undefined;
  // Real servers populate the Host header; tests driving app.request() with a
  // full URL may not, so fall back to the request URL's host.
  const rawHost = c.req.header('host') ?? new URL(c.req.url).host;
  const host = rawHost.split(':')[0]?.toLowerCase();
  if (!host) return undefined;
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return undefined;
  const label = host.slice(0, -suffix.length);
  // Reject empty and nested labels (`a.b.api.example.com` is not a tenant).
  if (!label || label.includes('.')) return undefined;
  return label;
}

function jwtClaimOf(c: Context, claim: string): string | undefined {
  // Set by hono/jwt (or compatible auth middleware) after verifying the token.
  const payload = (c.var as Record<string, unknown>)['jwtPayload'];
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[claim];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function tenantResolver<TTenant>(
  options: TenantResolverOptions<TTenant>,
): MiddlewareHandler {
  const sources = options.sources ?? DEFAULT_SOURCES;
  const headerName = options.headerName ?? DEFAULT_HEADER_NAME;
  const jwtClaim = options.jwtClaim ?? DEFAULT_JWT_CLAIM;

  return async (c, next) => {
    let ref: TenantRef | undefined;
    for (const source of sources) {
      let value: string | undefined;
      if (source === 'jwt') {
        value = jwtClaimOf(c, jwtClaim);
      } else if (source === 'subdomain') {
        value = subdomainOf(c, options.baseDomain);
      } else {
        value = c.req.header(headerName);
      }
      if (value) {
        ref = { source, value };
        break;
      }
    }

    if (!ref) {
      return c.json(
        {
          error: {
            code: 'TENANT_UNRESOLVED',
            message: 'Request could not be mapped to a tenant.',
          },
        },
        400,
      );
    }

    const tenant = await options.lookupTenant(ref, c);
    if (tenant == null) {
      // 404 (not 403) so probing requests cannot distinguish "tenant exists
      // but is not yours" from "tenant does not exist".
      return c.json(
        { error: { code: 'TENANT_NOT_FOUND', message: 'Unknown tenant.' } },
        404,
      );
    }

    c.set(TENANT_CONTEXT_KEY, tenant);
    return next();
  };
}

/** Read the tenant that {@link tenantResolver} stored on the context. */
export function getTenant<TTenant>(c: Context): TTenant {
  const tenant = (c.var as Record<string, unknown>)[TENANT_CONTEXT_KEY];
  if (tenant == null) {
    throw new Error(
      'No tenant on the request context. Is tenantResolver mounted before this handler?',
    );
  }
  return tenant as TTenant;
}
