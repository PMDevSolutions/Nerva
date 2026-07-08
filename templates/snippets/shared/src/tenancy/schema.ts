import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Tenancy schema additions.
 *
 * The `tenants` registry table always lives in the `public` schema, under
 * both isolation strategies — it is how a request is mapped to a tenant.
 *
 * - Row-based strategy: every resource table spreads {@link tenantScopedColumns}
 *   to get a `tenant_id` foreign key (see `projects` below for the pattern),
 *   and RLS policies enforce the boundary (src/db/rls-policies.sql).
 * - Schema-based strategy: resource tables are created once per tenant schema
 *   and do NOT need a `tenant_id` column; only `tenants` stays in `public`.
 */

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  // URL-safe identifier used for subdomain resolution (`acme.api.example.com`)
  // and, under the schema strategy, to derive the schema name (`tenant_acme`).
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

/**
 * Columns every tenant-scoped table must include under the row strategy.
 * A function (not a shared object) because Drizzle column builders are bound
 * to the table that consumes them — each table needs fresh instances.
 *
 * @example
 *   export const orders = pgTable('orders', {
 *     id: uuid('id').defaultRandom().primaryKey(),
 *     ...tenantScopedColumns(),
 *     // resource columns...
 *   }, (table) => [index('orders_tenant_id_idx').on(table.tenantId)]);
 */
export const tenantScopedColumns = () => ({
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
});

/**
 * Example tenant-scoped resource table demonstrating the row-based pattern:
 * `tenant_id` FK via {@link tenantScopedColumns} plus an index on it (every
 * query filters by tenant, so the index is not optional). Replace with your
 * real resource tables, keeping both pieces.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ...tenantScopedColumns(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('projects_tenant_id_idx').on(table.tenantId)],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
