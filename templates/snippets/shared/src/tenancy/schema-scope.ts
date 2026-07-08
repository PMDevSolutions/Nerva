import { sql, type TablesRelationalConfig } from 'drizzle-orm';
import type {
  PgDatabase,
  PgQueryResultHKT,
  PgTransaction,
} from 'drizzle-orm/pg-core';

/**
 * Schema-based tenant isolation (one PostgreSQL schema per tenant).
 *
 * Each tenant gets its own schema (`tenant_<slug>`) containing a full copy of
 * the resource tables. Queries run inside {@link withTenantSchema}, which
 * points `search_path` at the tenant's schema for the duration of a
 * transaction — unqualified table names (which is what Drizzle emits for
 * tables defined with `pgTable`) then resolve to the tenant's copy.
 *
 * `public` stays on the search path (after the tenant schema) so the shared
 * `tenants` registry and any extensions remain reachable. Resource tables
 * must therefore NOT also exist in `public`, or a missing tenant table would
 * silently fall through to the shared one — keep `public` free of resource
 * tables under this strategy.
 *
 * Migrations must be applied once per tenant schema. See
 * docs/api-development/multi-tenancy.md for a migration runner example.
 */

export const TENANT_SCHEMA_PREFIX = 'tenant_';

// Lowercase alphanumerics + underscore only, and short enough to stay under
// PostgreSQL's 63-byte identifier limit with the prefix. Anything else is
// rejected rather than escaped: schema names end up in DDL, log lines, and
// backups, so keep them boring.
const NORMALIZED_SLUG_PATTERN = /^[a-z0-9_]{1,48}$/;

/**
 * Derive the schema name for a tenant slug (`acme-corp` → `tenant_acme_corp`).
 * Throws on slugs that would produce an unsafe or over-long identifier.
 */
export function tenantSchemaName(slug: string): string {
  const normalized = slug.toLowerCase().replaceAll('-', '_');
  if (!NORMALIZED_SLUG_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid tenant slug for schema isolation: ${JSON.stringify(slug)}. ` +
        'Slugs must be 1-48 characters of [a-z0-9_-].',
    );
  }
  return `${TENANT_SCHEMA_PREFIX}${normalized}`;
}

/**
 * Create the tenant's schema (idempotent). Called during tenant onboarding;
 * run migrations against the new schema afterwards to create its tables.
 *
 * @returns the schema name.
 */
export async function createTenantSchema<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TQueryResult, TFullSchema, TSchema>,
  slug: string,
): Promise<string> {
  const schemaName = tenantSchemaName(slug);
  await db.execute(sql`create schema if not exists ${sql.identifier(schemaName)}`);
  return schemaName;
}

/**
 * Run `fn` inside a transaction with `search_path` pointed at the tenant's
 * schema (SET LOCAL semantics — the setting evaporates when the transaction
 * ends, so pooled connections are never left pointing at a tenant).
 *
 * @example
 *   const rows = await withTenantSchema(db, tenant.slug, (tx) =>
 *     tx.select().from(projects),
 *   );
 */
export async function withTenantSchema<
  T,
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TQueryResult, TFullSchema, TSchema>,
  slug: string,
  fn: (tx: PgTransaction<TQueryResult, TFullSchema, TSchema>) => Promise<T>,
): Promise<T> {
  const schemaName = tenantSchemaName(slug);
  return db.transaction(async (tx) => {
    // set_config(..., true) = SET LOCAL: scoped to this transaction only.
    // schemaName is validated by tenantSchemaName and passed as a bound
    // parameter, so it cannot smuggle SQL.
    await tx.execute(
      sql`select set_config('search_path', ${`${schemaName}, public`}, true)`,
    );
    return fn(tx);
  });
}
