# Multi-Tenancy Guide

How to build tenant-isolated SaaS APIs with Nerva. Generate a project with the
scaffolding included:

```bash
./scripts/setup-project.sh my-saas --node --multi-tenant   # any platform flag works
```

This adds `api/src/tenancy/` (tenant registry schema, resolution middleware,
scoped query helpers for both isolation strategies), an RLS policy template at
`api/src/db/rls-policies.sql`, and tenant-isolation tests at
`api/tests/tenancy.test.ts`.

## The two isolation strategies

Nerva supports both mainstream PostgreSQL tenancy models. Pick one per
deployment with `TENANCY_STRATEGY` (`row` is the default); the resolution
middleware and `tenants` registry are shared, only the data layer differs.

### Row-based isolation (`TENANCY_STRATEGY=row`)

All tenants share the same tables. Every tenant-scoped table carries a
`tenant_id` foreign key, every query filters on it, and PostgreSQL Row Level
Security enforces the boundary inside the database.

```
┌─────────────────────────────────────┐
│ public                              │
│  tenants   (id, name, slug, plan)   │
│  projects  (id, tenant_id, ...)     │  ← one table, all tenants,
│  orders    (id, tenant_id, ...)     │    RLS + WHERE tenant_id = $1
└─────────────────────────────────────┘
```

### Schema-based isolation (`TENANCY_STRATEGY=schema`)

Each tenant gets its own PostgreSQL schema containing a full copy of the
resource tables. Queries run with `search_path` pointed at the tenant's
schema; tables need no `tenant_id` column.

```
┌────────────────┐ ┌────────────────┐ ┌────────────────┐
│ public         │ │ tenant_acme    │ │ tenant_globex  │
│  tenants       │ │  projects      │ │  projects      │
│  (registry)    │ │  orders        │ │  orders        │
└────────────────┘ └────────────────┘ └────────────────┘
```

## Trade-offs: which strategy to choose

| Dimension | Row-based (`tenant_id` + RLS) | Schema-based (schema per tenant) |
|-----------|-------------------------------|----------------------------------|
| Isolation strength | Logical — enforced by RLS policies and query filters | Structural — data lives in physically separate namespaces |
| Tenant count | Scales to millions of tenants | Practical up to low thousands; catalogs, backups, and migrations degrade beyond that |
| Tenant onboarding | One `INSERT INTO tenants` | `CREATE SCHEMA` + run migrations for the new schema |
| Migrations | One migration run for everyone | One run **per tenant schema**; slow rollouts, risk of drift if a run fails midway |
| Cross-tenant queries (admin dashboards, aggregate analytics) | Trivial — omit the filter with a privileged role | Painful — `UNION` across schemas or ETL into a warehouse |
| Per-tenant backup / restore / export | Row-filtered dumps (fiddly) | `pg_dump --schema=tenant_x` (natural) |
| Noisy-neighbor blast radius | Shared tables and indexes; one tenant's bloat affects all | Separate indexes per tenant; still shared CPU/IO on one server |
| Per-tenant customization (extra columns, retention) | Hard — schema is shared | Easy — schemas can diverge (at the cost of drift) |
| Connection pooling | Pool-friendly: tenant context is per-transaction (`SET LOCAL`) | Pool-friendly with `SET LOCAL search_path`, but plan caches grow per schema |
| Compliance optics | "Logically isolated" — fine for most SOC 2 / GDPR setups | "Physically separated" — easier story for strict enterprise/regulated buyers |
| Operational complexity | Low | Medium-high (migration runner, schema lifecycle, monitoring per schema) |

**Default to row-based.** It scales further, keeps migrations and analytics
simple, and RLS gives you database-enforced isolation without physical
separation. Choose schema-based when you have a bounded number of high-value
tenants that demand stronger separation, per-tenant restore/export, or
per-tenant schema divergence — or as a stepping stone to database-per-tenant
for your largest customers. (Full database-per-tenant is out of scope for this
template; it is the same trade-off pushed one level up.)

## Tenant resolution

`tenantResolver` (in `src/tenancy/middleware.ts`) maps each request to a
tenant and stores it on the Hono context. Three sources are supported, tried
in priority order (default `['jwt', 'subdomain', 'header']`):

| Source | Example | Trust |
|--------|---------|-------|
| JWT claim | `tenant_id` claim in the verified token | Signed — cannot be spoofed. Default first. |
| Subdomain | `acme.api.example.com` → slug `acme` | Controlled by DNS/routing. Good for public APIs. |
| `X-Tenant-ID` header | `X-Tenant-ID: <uuid>` | **Spoofable.** Only trust behind a gateway that strips it from external traffic, or verify membership in `lookupTenant`. |

```typescript
import { eq } from 'drizzle-orm';
import { tenantResolver, getTenant } from './tenancy/middleware';
import { tenants, type Tenant } from './tenancy/schema';
import { loadTenancyConfig } from './tenancy/config';

const tenancy = loadTenancyConfig();

app.use(
  '/api/*',
  tenantResolver({
    baseDomain: tenancy.baseDomain,
    headerName: tenancy.headerName,
    jwtClaim: tenancy.jwtClaim,
    lookupTenant: async (ref) =>
      db.query.tenants.findFirst({
        where: ref.source === 'subdomain'
          ? eq(tenants.slug, ref.value)
          : eq(tenants.id, ref.value),
      }),
  }),
);
```

Unresolvable requests get `400 TENANT_UNRESOLVED`; unknown tenants get `404
TENANT_NOT_FOUND` (404 rather than 403, so probes cannot enumerate tenants).
When you mount `hono/jwt`, mount it *before* the resolver so the verified
payload is available, and put per-tenant caching inside `lookupTenant` — it
runs on every request.

## Row strategy in practice

### Schema additions

`src/tenancy/schema.ts` defines the `tenants` registry and a
`tenantScopedColumns()` helper. Every resource table spreads it and indexes
the column:

```typescript
export const orders = pgTable('orders', {
  id: uuid('id').defaultRandom().primaryKey(),
  ...tenantScopedColumns(),           // tenant_id uuid NOT NULL REFERENCES tenants(id)
  total: integer('total').notNull(),
}, (table) => [index('orders_tenant_id_idx').on(table.tenantId)]);
```

The generated `drizzle.config.ts` already includes `src/tenancy/schema.ts`,
so `pnpm drizzle-kit generate` picks these tables up.

### Scoped queries

Isolation is enforced twice, deliberately:

1. **Application layer** — `createTenantDb` returns a facade whose every
   method injects the tenant predicate, so handlers cannot forget it:

   ```typescript
   app.get('/api/projects', async (c) => {
     const tenant = getTenant<Tenant>(c);
     const tdb = createTenantDb(db, tenant.id);
     return c.json(await tdb.findMany(projects));          // WHERE tenant_id = $1
   });

   // findFirst / insert / update / delete are scoped the same way:
   await tdb.insert(projects, { name: 'Q3 launch' });      // tenant_id injected
   await tdb.update(projects, { name: 'Q4' }, eq(projects.id, id));
   ```

   For hand-written queries, compose `withTenantFilter(table, tenantId, ...)`
   into the `where` clause — same pattern as the soft-delete helpers.

2. **Database layer (RLS)** — `withTenant` binds `app.tenant_id` for one
   transaction; the policies compare each row against it:

   ```typescript
   const rows = await withTenant(db, tenant.id, (tx) =>
     tx.select().from(projects).where(withTenantFilter(projects, tenant.id)),
   );
   ```

   The application filter gives correct results and index-friendly plans; RLS
   is the backstop that turns a forgotten filter into *zero rows* instead of
   a cross-tenant data leak.

### Enabling RLS

The policy template is copied to `api/src/db/rls-policies.sql`. Ship it as a
custom migration:

```bash
pnpm drizzle-kit generate --custom --name enable-rls
# paste the SQL (one block per tenant-scoped table) into the new migration
pnpm drizzle-kit migrate
```

Each block enables + forces RLS and adds one `FOR ALL` policy whose `USING`
clause hides other tenants' rows and whose `WITH CHECK` clause blocks writing
them (including `UPDATE ... SET tenant_id = <other>`). The policy reads
`current_setting('app.tenant_id', true)` and **fails closed**: no tenant
context, no rows.

Two things bypass RLS and must be avoided for the API's database user:

- **Superusers and `BYPASSRLS` roles** ignore policies entirely. The default
  `postgres` user in most Docker images is a superuser — create a dedicated
  application role (the template's header comment has the statements).
- **Table owners** ignore policies unless `FORCE ROW LEVEL SECURITY` is set —
  the template sets it on every table.

## Schema strategy in practice

Onboarding creates the schema, then applies migrations to it:

```typescript
import { createTenantSchema, withTenantSchema } from './tenancy/schema-scope';

await db.insert(tenants).values({ name: 'Acme', slug: 'acme' });
await createTenantSchema(db, 'acme');                      // CREATE SCHEMA tenant_acme
```

Queries run inside `withTenantSchema`, which points `search_path` at the
tenant's schema with `SET LOCAL` (transaction-scoped, so pooled connections
never leak a tenant):

```typescript
const rows = await withTenantSchema(db, tenant.slug, (tx) =>
  tx.select().from(projects),                              // resolves to tenant_acme.projects
);
```

Slugs are validated (`[a-z0-9_-]{1,48}`) before being turned into
identifiers; anything else throws rather than getting escaped into DDL.

### Migrations per tenant schema

Migrations must run once per schema. A minimal runner using Drizzle's
programmatic migrator (Node targets):

```typescript
// scripts/migrate-tenants.ts — run with: pnpm tsx scripts/migrate-tenants.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { tenants } from '../src/tenancy/schema';
import { tenantSchemaName } from '../src/tenancy/schema-scope';

const client = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(client);

for (const tenant of await db.select().from(tenants)) {
  const schema = tenantSchemaName(tenant.slug);
  await client.unsafe(`set search_path to "${schema}", public`);
  await migrate(db, {
    migrationsFolder: './src/db/migrations',
    migrationsSchema: schema,          // per-schema migration journal
  });
  console.log(`migrated ${schema}`);
}
await client.end();
```

Run it in CI/CD after deploying, and at onboarding for the new tenant's
schema. Keep resource tables **out of `public`** under this strategy:
`search_path` falls through to `public`, so a stray shared copy of a table
would silently serve requests for any tenant whose schema is missing it.

## Caveats that apply to both strategies

- **`SET LOCAL` + poolers.** Both `withTenant` and `withTenantSchema` bind
  tenant context with `set_config(..., true)` inside a transaction, which is
  safe with connection pooling (including transaction-mode PgBouncer). Never
  use session-level `SET` for tenant context on pooled connections.
- **The `tenants` registry is not tenant-scoped.** The resolver must read it
  before any tenant context exists; don't add RLS to it (or give it only a
  permissive read policy).
- **Admin/cross-tenant paths must be explicit.** Analytics jobs or support
  tooling that legitimately crosses tenants should use a separate privileged
  role and never share code paths with request handlers.

## Testing tenant isolation

`api/tests/tenancy.test.ts` runs in two layers:

- **Always on** (no database needed): resolution from subdomain/header/JWT,
  precedence and rejection cases, and SQL-level assertions that every
  `createTenantDb` method and both `SET LOCAL` helpers emit tenant-scoped
  statements.
- **Live suite** (opt-in): proves isolation against a real PostgreSQL — RLS
  visibility per tenant, fail-closed with no context, `WITH CHECK` blocking
  cross-tenant writes, and `search_path` schema isolation — running as a
  dedicated non-superuser role, the same shape production should use.

```bash
docker compose up -d
TENANCY_TEST_DATABASE_URL=postgresql://nerva:nerva_secret@localhost:5432/nerva_db pnpm test
```

Treat the live suite as a required CI gate for any real multi-tenant product:
run it against the CI database service so a policy regression fails the build
instead of leaking a tenant's data.
