import { z } from 'zod';

/**
 * Multi-tenancy configuration.
 *
 * Nerva supports two tenant isolation strategies, selected per deployment via
 * the TENANCY_STRATEGY environment variable:
 *
 * - `row` (default): all tenants share the same tables; every tenant-scoped
 *   table carries a `tenant_id` column, queries are filtered by it (see
 *   ./row-scope.ts), and PostgreSQL Row Level Security enforces the boundary
 *   in the database itself (see src/db/rls-policies.sql).
 * - `schema`: each tenant gets its own PostgreSQL schema containing a full
 *   copy of the resource tables; queries run with `search_path` pointed at
 *   the tenant's schema (see ./schema-scope.ts).
 *
 * The trade-offs between the two are documented in
 * docs/api-development/multi-tenancy.md in the Nerva framework repository.
 */

export const TENANCY_STRATEGIES = ['row', 'schema'] as const;

export type TenancyStrategy = (typeof TENANCY_STRATEGIES)[number];

const tenancyEnvSchema = z.object({
  TENANCY_STRATEGY: z.enum(TENANCY_STRATEGIES).default('row'),
  // Base domain for subdomain tenant resolution, e.g. `api.example.com` so
  // that `acme.api.example.com` resolves to the tenant with slug `acme`.
  // Leave unset to disable the subdomain source.
  TENANCY_BASE_DOMAIN: z.string().min(1).optional(),
  TENANCY_HEADER_NAME: z.string().min(1).default('X-Tenant-ID'),
  TENANCY_JWT_CLAIM: z.string().min(1).default('tenant_id'),
});

export interface TenancyConfig {
  strategy: TenancyStrategy;
  baseDomain: string | undefined;
  headerName: string;
  jwtClaim: string;
}

/**
 * Parse tenancy settings from an environment object. Defaults to
 * `process.env`; Cloudflare Workers should pass the request's env bindings
 * instead (matching how src/config.ts is loaded on that target).
 */
export function loadTenancyConfig(
  env: Record<string, string | undefined> = process.env,
): TenancyConfig {
  const parsed = tenancyEnvSchema.parse(env);
  return {
    strategy: parsed.TENANCY_STRATEGY,
    baseDomain: parsed.TENANCY_BASE_DOMAIN,
    headerName: parsed.TENANCY_HEADER_NAME,
    jwtClaim: parsed.TENANCY_JWT_CLAIM,
  };
}
