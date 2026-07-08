import {
  and,
  eq,
  sql,
  type SQL,
  type TablesRelationalConfig,
} from 'drizzle-orm';
import type {
  PgColumn,
  PgDatabase,
  PgQueryResultHKT,
  PgTable,
  PgTransaction,
  PgUpdateSetSource,
} from 'drizzle-orm/pg-core';

/**
 * Row-based tenant isolation (shared tables + `tenant_id` column).
 *
 * Isolation is enforced twice, on purpose:
 *
 * 1. **Application layer** — every query goes through {@link createTenantDb}
 *    (or, for hand-written queries, {@link withTenantFilter}), so the
 *    `tenant_id` predicate cannot be forgotten.
 * 2. **Database layer** — Row Level Security policies (src/db/rls-policies.sql)
 *    check `tenant_id` against the `app.tenant_id` session setting, which
 *    {@link withTenant} sets for the duration of a transaction. If a query
 *    slips through without a filter, RLS returns zero rows instead of
 *    leaking another tenant's data (fail closed).
 *
 * Belt and braces: the app filter gives correct results and index-friendly
 * plans; RLS guards against the query that forgot the filter.
 */

/** PostgreSQL session setting the RLS policies read the current tenant from. */
export const TENANT_ID_SETTING = 'app.tenant_id';

/**
 * Minimal column shape a table must expose to participate in row-based
 * tenancy: a `tenantId` column (see `tenantScopedColumns()` in ./schema.ts).
 */
export interface TenantScopedColumns {
  tenantId: PgColumn;
}

/** A Drizzle pgTable that carries the tenant scoping column. */
export type TenantScopedTable = PgTable & TenantScopedColumns;

/**
 * Query filter matching only rows that belong to the given tenant
 * (`WHERE tenant_id = $tenantId`).
 */
export function tenantFilter(table: TenantScopedColumns, tenantId: string): SQL {
  return eq(table.tenantId, tenantId);
}

/**
 * Combine the tenant filter with any number of additional conditions, ANDed
 * together. `undefined` conditions are ignored, mirroring Drizzle's `and()`.
 *
 * @example
 *   db.select().from(projects).where(withTenantFilter(projects, tenantId, eq(projects.name, name)));
 */
export function withTenantFilter(
  table: TenantScopedColumns,
  tenantId: string,
  ...conditions: Array<SQL | undefined>
): SQL | undefined {
  return and(tenantFilter(table, tenantId), ...conditions);
}

/**
 * Run `fn` inside a transaction with the `app.tenant_id` session setting
 * bound to the tenant (SET LOCAL semantics — the setting evaporates when the
 * transaction ends, so pooled connections are never left carrying a tenant).
 * RLS policies read this setting; queries issued outside `withTenant` see
 * zero tenant-scoped rows once RLS is enabled.
 *
 * @example
 *   const rows = await withTenant(db, tenant.id, (tx) =>
 *     tx.select().from(projects).where(withTenantFilter(projects, tenant.id)),
 *   );
 */
export async function withTenant<
  T,
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TQueryResult, TFullSchema, TSchema>,
  tenantId: string,
  fn: (tx: PgTransaction<TQueryResult, TFullSchema, TSchema>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // set_config(..., true) = SET LOCAL: scoped to this transaction only.
    await tx.execute(sql`select set_config(${TENANT_ID_SETTING}, ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * Tenant-scoped query facade returned by {@link createTenantDb}. Every method
 * injects the tenant predicate automatically, so route/service code cannot
 * forget it.
 */
export interface TenantDb {
  readonly tenantId: string;
  findMany<TTable extends TenantScopedTable>(
    table: TTable,
    ...conditions: Array<SQL | undefined>
  ): Promise<Array<TTable['$inferSelect']>>;
  findFirst<TTable extends TenantScopedTable>(
    table: TTable,
    ...conditions: Array<SQL | undefined>
  ): Promise<TTable['$inferSelect'] | undefined>;
  insert<TTable extends TenantScopedTable>(
    table: TTable,
    values: Omit<TTable['$inferInsert'], 'tenantId'>,
  ): Promise<TTable['$inferSelect']>;
  update<TTable extends TenantScopedTable>(
    table: TTable,
    set: PgUpdateSetSource<TTable>,
    ...conditions: Array<SQL | undefined>
  ): Promise<Array<TTable['$inferSelect']>>;
  delete<TTable extends TenantScopedTable>(
    table: TTable,
    ...conditions: Array<SQL | undefined>
  ): Promise<number>;
}

/**
 * Create a {@link TenantDb} bound to one tenant — typically once per request,
 * from the tenant the middleware resolved:
 *
 * @example
 *   app.get('/projects', async (c) => {
 *     const tenant = getTenant<Tenant>(c);
 *     const tdb = createTenantDb(db, tenant.id);
 *     return c.json(await tdb.findMany(projects));
 *   });
 */
export function createTenantDb<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(db: PgDatabase<TQueryResult, TFullSchema, TSchema>, tenantId: string): TenantDb {
  return {
    tenantId,

    async findMany<TTable extends TenantScopedTable>(
      table: TTable,
      ...conditions: Array<SQL | undefined>
    ): Promise<Array<TTable['$inferSelect']>> {
      const rows = await db
        .select()
        .from(table as PgTable)
        .where(withTenantFilter(table, tenantId, ...conditions));
      return rows as Array<TTable['$inferSelect']>;
    },

    async findFirst<TTable extends TenantScopedTable>(
      table: TTable,
      ...conditions: Array<SQL | undefined>
    ): Promise<TTable['$inferSelect'] | undefined> {
      const rows = await db
        .select()
        .from(table as PgTable)
        .where(withTenantFilter(table, tenantId, ...conditions))
        .limit(1);
      return rows[0] as TTable['$inferSelect'] | undefined;
    },

    async insert<TTable extends TenantScopedTable>(
      table: TTable,
      values: Omit<TTable['$inferInsert'], 'tenantId'>,
    ): Promise<TTable['$inferSelect']> {
      const rows = await db
        .insert(table)
        .values({ ...values, tenantId } as unknown as TTable['$inferInsert'])
        .returning();
      const row = rows[0];
      if (!row) {
        throw new Error('Tenant-scoped insert returned no rows.');
      }
      return row as TTable['$inferSelect'];
    },

    async update<TTable extends TenantScopedTable>(
      table: TTable,
      set: PgUpdateSetSource<TTable>,
      ...conditions: Array<SQL | undefined>
    ): Promise<Array<TTable['$inferSelect']>> {
      if ('tenantId' in (set as Record<string, unknown>)) {
        throw new Error(
          'Tenant-scoped update() must not change tenantId — rows cannot be moved between tenants.',
        );
      }
      const rows = await db
        .update(table)
        .set(set)
        .where(withTenantFilter(table, tenantId, ...conditions))
        .returning();
      return rows as Array<TTable['$inferSelect']>;
    },

    async delete<TTable extends TenantScopedTable>(
      table: TTable,
      ...conditions: Array<SQL | undefined>
    ): Promise<number> {
      const rows = await db
        .delete(table)
        .where(withTenantFilter(table, tenantId, ...conditions))
        .returning();
      return rows.length;
    },
  };
}
