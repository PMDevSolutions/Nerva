import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { loadTenancyConfig } from '../src/tenancy/config.js';
import { tenants, projects, type Tenant } from '../src/tenancy/schema.js';
import {
  getTenant,
  tenantResolver,
  type TenantRef,
} from '../src/tenancy/middleware.js';
import {
  createTenantDb,
  tenantFilter,
  withTenant,
  withTenantFilter,
  TENANT_ID_SETTING,
} from '../src/tenancy/row-scope.js';
import {
  createTenantSchema,
  tenantSchemaName,
  withTenantSchema,
} from '../src/tenancy/schema-scope.js';

const dialect = new PgDialect();
const render = (clause: Parameters<PgDialect['sqlToQuery']>[0] | undefined) =>
  clause ? dialect.sqlToQuery(clause) : undefined;

const TENANT_A: Tenant = {
  id: '00000000-0000-4000-8000-00000000000a',
  name: 'Acme',
  slug: 'acme',
  plan: 'pro',
  createdAt: new Date(0),
};
const TENANT_B: Tenant = {
  id: '00000000-0000-4000-8000-00000000000b',
  name: 'Globex',
  slug: 'globex',
  plan: 'free',
  createdAt: new Date(0),
};

// ---------------------------------------------------------------------------
// Configuration (strategy selection)
// ---------------------------------------------------------------------------

describe('loadTenancyConfig', () => {
  it('defaults to the row strategy', () => {
    expect(loadTenancyConfig({}).strategy).toBe('row');
  });

  it('selects the schema strategy via TENANCY_STRATEGY', () => {
    expect(loadTenancyConfig({ TENANCY_STRATEGY: 'schema' }).strategy).toBe('schema');
  });

  it('rejects unknown strategies', () => {
    expect(() => loadTenancyConfig({ TENANCY_STRATEGY: 'shard' })).toThrow();
  });

  it('applies resolution defaults and overrides', () => {
    const defaults = loadTenancyConfig({});
    expect(defaults.headerName).toBe('X-Tenant-ID');
    expect(defaults.jwtClaim).toBe('tenant_id');
    expect(defaults.baseDomain).toBeUndefined();

    const custom = loadTenancyConfig({
      TENANCY_BASE_DOMAIN: 'api.example.com',
      TENANCY_HEADER_NAME: 'X-Org',
      TENANCY_JWT_CLAIM: 'org_id',
    });
    expect(custom.baseDomain).toBe('api.example.com');
    expect(custom.headerName).toBe('X-Org');
    expect(custom.jwtClaim).toBe('org_id');
  });
});

// ---------------------------------------------------------------------------
// Tenant resolution middleware
// ---------------------------------------------------------------------------

describe('tenantResolver', () => {
  const lookupTenant = async (ref: TenantRef): Promise<Tenant | null> => {
    const bySlug: Record<string, Tenant> = { acme: TENANT_A, globex: TENANT_B };
    const byId: Record<string, Tenant> = {
      [TENANT_A.id]: TENANT_A,
      [TENANT_B.id]: TENANT_B,
    };
    if (ref.source === 'subdomain') return bySlug[ref.value] ?? null;
    return byId[ref.value] ?? null;
  };

  type TestEnv = { Variables: { jwtPayload?: Record<string, unknown>; tenant: Tenant } };

  function makeApp(jwtPayload?: Record<string, unknown>) {
    const app = new Hono<TestEnv>();
    if (jwtPayload) {
      // Stands in for hono/jwt, which stores the verified payload the same way.
      app.use('*', async (c, next) => {
        c.set('jwtPayload', jwtPayload);
        await next();
      });
    }
    app.use('*', tenantResolver({ lookupTenant, baseDomain: 'api.example.com' }));
    app.get('/whoami', (c) => c.json(getTenant<Tenant>(c)));
    return app;
  }

  it('resolves the tenant from the subdomain', async () => {
    const res = await makeApp().request('http://acme.api.example.com/whoami');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Tenant).id).toBe(TENANT_A.id);
  });

  it('strips the port before matching the subdomain', async () => {
    const res = await makeApp().request('http://globex.api.example.com:8787/whoami');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Tenant).id).toBe(TENANT_B.id);
  });

  it('resolves the tenant from the X-Tenant-ID header', async () => {
    const res = await makeApp().request('http://localhost/whoami', {
      headers: { 'X-Tenant-ID': TENANT_B.id },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Tenant).slug).toBe('globex');
  });

  it('resolves the tenant from the JWT claim', async () => {
    const res = await makeApp({ sub: 'user-1', tenant_id: TENANT_A.id }).request(
      'http://localhost/whoami',
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Tenant).slug).toBe('acme');
  });

  it('prefers the (signed) JWT claim over subdomain and header', async () => {
    const res = await makeApp({ tenant_id: TENANT_A.id }).request(
      'http://globex.api.example.com/whoami',
      { headers: { 'X-Tenant-ID': TENANT_B.id } },
    );
    expect(((await res.json()) as Tenant).id).toBe(TENANT_A.id);
  });

  it('honours a custom source order', async () => {
    const app = new Hono<TestEnv>();
    app.use(
      '*',
      tenantResolver({
        lookupTenant,
        baseDomain: 'api.example.com',
        sources: ['subdomain', 'jwt'],
      }),
    );
    app.get('/whoami', (c) => c.json(getTenant<Tenant>(c)));
    const res = await app.request('http://globex.api.example.com/whoami', {
      headers: { 'X-Tenant-ID': TENANT_A.id }, // header source disabled
    });
    expect(((await res.json()) as Tenant).id).toBe(TENANT_B.id);
  });

  it('returns 404 for an unknown tenant', async () => {
    const res = await makeApp().request('http://nope.api.example.com/whoami');
    expect(res.status).toBe(404);
  });

  it('returns 400 when no source yields a tenant', async () => {
    const res = await makeApp().request('http://localhost/whoami');
    expect(res.status).toBe(400);
  });

  it('does not treat nested subdomains as tenants', async () => {
    const res = await makeApp().request('http://a.b.api.example.com/whoami');
    expect(res.status).toBe(400);
  });

  it('does not treat the bare base domain as a tenant', async () => {
    const res = await makeApp().request('http://api.example.com/whoami');
    expect(res.status).toBe(400);
  });

  it('getTenant throws when the resolver is not mounted', async () => {
    const app = new Hono();
    app.onError((err, c) => c.text(err.message, 500));
    app.get('/whoami', (c) => c.json(getTenant<Tenant>(c)));
    const res = await app.request('http://localhost/whoami');
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('tenantResolver');
  });
});

// ---------------------------------------------------------------------------
// Row-based scoping (tenant_id filters)
// ---------------------------------------------------------------------------

describe('tenantFilter / withTenantFilter', () => {
  it('produces a `tenant_id = $x` predicate', () => {
    const query = render(tenantFilter(projects, TENANT_A.id))!;
    expect(query.sql).toContain('"tenant_id"');
    expect(query.params).toContain(TENANT_A.id);
  });

  it('ANDs the tenant filter with extra conditions', () => {
    const query = render(withTenantFilter(projects, TENANT_A.id, eq(projects.name, 'x')))!;
    expect(query.sql).toContain('"tenant_id"');
    expect(query.sql).toContain('"name"');
    expect(query.sql.toLowerCase()).toContain('and');
  });
});

/**
 * Chainable stub standing in for a Drizzle PgDatabase: records the clauses
 * each query was built with and resolves with the configured rows, so tenant
 * scoping can be asserted without PostgreSQL.
 */
function makeStubDb(rows: unknown[] = []) {
  const calls: {
    where?: unknown;
    values?: Record<string, unknown>;
    set?: unknown;
    executed: unknown[];
  } = { executed: [] };

  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn((clause: unknown) => {
      calls.where = clause;
      return selectChain;
    }),
    limit: vi.fn(() => Promise.resolve(rows)),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  const writeChain = {
    values: vi.fn((values: Record<string, unknown>) => {
      calls.values = values;
      return writeChain;
    }),
    set: vi.fn((set: unknown) => {
      calls.set = set;
      return writeChain;
    }),
    where: vi.fn((clause: unknown) => {
      calls.where = clause;
      return writeChain;
    }),
    returning: vi.fn(() => Promise.resolve(rows)),
  };
  const tx = {
    execute: vi.fn((query: unknown) => {
      calls.executed.push(query);
      return Promise.resolve([]);
    }),
  };
  const db = {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => writeChain),
    update: vi.fn(() => writeChain),
    delete: vi.fn(() => writeChain),
    execute: tx.execute,
    transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { db, calls, tx };
}

describe('createTenantDb', () => {
  it('findMany always includes the tenant predicate', async () => {
    const { db, calls } = makeStubDb([]);
    await createTenantDb(db as never, TENANT_A.id).findMany(projects);
    const query = render(calls.where as never)!;
    expect(query.sql).toContain('"tenant_id"');
    expect(query.params).toContain(TENANT_A.id);
  });

  it('findFirst combines the tenant predicate with caller conditions', async () => {
    const { db, calls } = makeStubDb([]);
    await createTenantDb(db as never, TENANT_A.id).findFirst(
      projects,
      eq(projects.name, 'x'),
    );
    const query = render(calls.where as never)!;
    expect(query.sql).toContain('"tenant_id"');
    expect(query.sql).toContain('"name"');
    expect(query.params).toContain(TENANT_A.id);
  });

  it('insert injects tenantId into the values', async () => {
    const { db, calls } = makeStubDb([{ id: 'p1' }]);
    await createTenantDb(db as never, TENANT_A.id).insert(projects, { name: 'x' });
    expect(calls.values).toMatchObject({ name: 'x', tenantId: TENANT_A.id });
  });

  it('update scopes the where clause to the tenant', async () => {
    const { db, calls } = makeStubDb([]);
    await createTenantDb(db as never, TENANT_A.id).update(projects, { name: 'y' });
    const query = render(calls.where as never)!;
    expect(query.sql).toContain('"tenant_id"');
    expect(query.params).toContain(TENANT_A.id);
  });

  it('update refuses to re-home a row to another tenant', async () => {
    const { db } = makeStubDb([]);
    const tdb = createTenantDb(db as never, TENANT_A.id);
    await expect(
      tdb.update(projects, { tenantId: TENANT_B.id } as never),
    ).rejects.toThrow(/tenantId/);
  });

  it('delete scopes the where clause to the tenant and returns the count', async () => {
    const { db, calls } = makeStubDb([{ id: 'p1' }, { id: 'p2' }]);
    const deleted = await createTenantDb(db as never, TENANT_A.id).delete(projects);
    expect(deleted).toBe(2);
    const query = render(calls.where as never)!;
    expect(query.sql).toContain('"tenant_id"');
  });
});

describe('withTenant (RLS session setting)', () => {
  it('sets app.tenant_id with SET LOCAL semantics inside the transaction', async () => {
    const { db, calls, tx } = makeStubDb();
    const result = await withTenant(db as never, TENANT_A.id, async (scopedTx) => {
      expect(scopedTx).toBe(tx);
      return 'done';
    });
    expect(result).toBe('done');
    const query = render(calls.executed[0] as never)!;
    expect(query.sql).toContain('set_config');
    expect(query.sql).toContain('true'); // is_local => SET LOCAL
    expect(query.params).toEqual([TENANT_ID_SETTING, TENANT_A.id]);
  });
});

// ---------------------------------------------------------------------------
// Schema-based scoping (search_path)
// ---------------------------------------------------------------------------

describe('tenantSchemaName', () => {
  it('derives a prefixed, normalized schema name', () => {
    expect(tenantSchemaName('acme')).toBe('tenant_acme');
    expect(tenantSchemaName('Acme-Corp')).toBe('tenant_acme_corp');
  });

  it('rejects slugs that are not safe identifiers', () => {
    expect(() => tenantSchemaName('')).toThrow();
    expect(() => tenantSchemaName('bad;drop table tenants')).toThrow();
    expect(() => tenantSchemaName('spaced slug')).toThrow();
    expect(() => tenantSchemaName('a'.repeat(49))).toThrow();
  });
});

describe('createTenantSchema / withTenantSchema', () => {
  it('creates the schema with a quoted identifier', async () => {
    const { db, calls } = makeStubDb();
    const name = await createTenantSchema(db as never, 'acme');
    expect(name).toBe('tenant_acme');
    const query = render(calls.executed[0] as never)!;
    expect(query.sql.toLowerCase()).toContain('create schema if not exists');
    expect(query.sql).toContain('"tenant_acme"');
  });

  it('points search_path at the tenant schema for the transaction only', async () => {
    const { db, calls } = makeStubDb();
    await withTenantSchema(db as never, 'acme', async () => 'ok');
    const query = render(calls.executed[0] as never)!;
    expect(query.sql).toContain('set_config');
    expect(query.sql).toContain('true'); // is_local => SET LOCAL
    expect(query.params).toEqual(['tenant_acme, public']);
  });

  it('never runs a query for an invalid slug', async () => {
    const { db, tx } = makeStubDb();
    await expect(withTenantSchema(db as never, 'bad slug', async () => 'x')).rejects.toThrow();
    expect(tx.execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Live database isolation tests (opt-in)
//
// Verifies the RLS policies and search_path isolation against a real
// PostgreSQL. Skipped unless TENANCY_TEST_DATABASE_URL is set, e.g.:
//
//   docker compose up -d
//   TENANCY_TEST_DATABASE_URL=postgresql://nerva:nerva_secret@localhost:5432/nerva_db pnpm test
//
// Everything runs in a throwaway namespace and role, cleaned up afterwards.
// ---------------------------------------------------------------------------

const LIVE_URL = process.env['TENANCY_TEST_DATABASE_URL'];

describe.runIf(Boolean(LIVE_URL))('tenant isolation (live PostgreSQL)', () => {
  const ns = `tenancy_test_${Date.now().toString(36)}`;
  const appRole = `${ns}_app`;
  let db: postgres.Sql;

  beforeAll(async () => {
    db = postgres(LIVE_URL as string, { max: 1, onnotice: () => undefined });

    // Mirror of the row-strategy setup: tenants registry + one scoped table,
    // with the policies from templates/multi-tenant/rls-policies.sql.
    await db.unsafe(`
      create schema ${ns};
      create table ${ns}.tenants (
        id uuid primary key,
        slug text not null unique
      );
      create table ${ns}.projects (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references ${ns}.tenants (id) on delete cascade,
        name text not null
      );
      create index on ${ns}.projects (tenant_id);
      alter table ${ns}.projects enable row level security;
      alter table ${ns}.projects force row level security;
      create policy tenant_isolation on ${ns}.projects
        for all
        using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
    `);

    // RLS is bypassed by superusers and (without FORCE) table owners, so the
    // assertions below run as a dedicated non-superuser application role —
    // the same shape a production deployment should use.
    await db.unsafe(`
      create role ${appRole} nologin;
      grant usage on schema ${ns} to ${appRole};
      grant select, insert, update, delete on all tables in schema ${ns} to ${appRole};
    `);

    await db`insert into ${db(ns)}.tenants ${db([
      { id: TENANT_A.id, slug: TENANT_A.slug },
      { id: TENANT_B.id, slug: TENANT_B.slug },
    ])}`;

    // Seed one project per tenant through the tenant-scoped write path.
    for (const tenant of [TENANT_A, TENANT_B]) {
      await db.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenant.id}, true)`;
        await tx.unsafe(`set local role ${appRole}`);
        await tx`insert into ${tx(ns)}.projects (tenant_id, name)
                 values (${tenant.id}, ${`${tenant.slug}-project`})`;
      });
    }
  });

  afterAll(async () => {
    await db.unsafe(`
      drop schema if exists ${ns} cascade;
      drop schema if exists ${ns}_sa cascade;
      drop schema if exists ${ns}_sb cascade;
      drop owned by ${appRole};
      drop role ${appRole};
    `);
    await db.end();
  });

  /** Run `fn` as the app role with app.tenant_id bound (or not) for one transaction. */
  const asTenant = <T>(
    tenantId: string | null,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ) =>
    db.begin(async (tx) => {
      if (tenantId) {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      }
      await tx.unsafe(`set local role ${appRole}`);
      return fn(tx);
    });

  it('RLS: each tenant sees only its own rows', async () => {
    const rowsA = await asTenant(TENANT_A.id, (tx) => tx`select name from ${tx(ns)}.projects`);
    expect(rowsA.map((r) => r['name'])).toEqual(['acme-project']);

    const rowsB = await asTenant(TENANT_B.id, (tx) => tx`select name from ${tx(ns)}.projects`);
    expect(rowsB.map((r) => r['name'])).toEqual(['globex-project']);
  });

  it('RLS: no tenant context means no rows (fail closed)', async () => {
    const rows = await asTenant(null, (tx) => tx`select * from ${tx(ns)}.projects`);
    expect(rows).toHaveLength(0);
  });

  it("RLS: WITH CHECK blocks writing rows for another tenant", async () => {
    await expect(
      asTenant(TENANT_A.id, (tx) =>
        tx`insert into ${tx(ns)}.projects (tenant_id, name) values (${TENANT_B.id}, ${'smuggled'})`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("RLS: updates cannot reach another tenant's rows", async () => {
    const updated = await asTenant(TENANT_A.id, (tx) =>
      tx`update ${tx(ns)}.projects set name = ${'hijacked'}
         where tenant_id = ${TENANT_B.id} returning id`,
    );
    expect(updated).toHaveLength(0);

    const intact = await asTenant(TENANT_B.id, (tx) => tx`select name from ${tx(ns)}.projects`);
    expect(intact.map((r) => r['name'])).toEqual(['globex-project']);
  });

  it("RLS: deletes cannot reach another tenant's rows", async () => {
    const deleted = await asTenant(TENANT_A.id, (tx) =>
      tx`delete from ${tx(ns)}.projects where tenant_id = ${TENANT_B.id} returning id`,
    );
    expect(deleted).toHaveLength(0);
  });

  it('schema strategy: search_path isolates per-tenant schemas', async () => {
    // Two tenant schemas, same table name, different data.
    for (const [schema, name] of [
      [`${ns}_sa`, 'alpha-doc'],
      [`${ns}_sb`, 'bravo-doc'],
    ] as const) {
      await db.unsafe(`
        create schema ${schema};
        create table ${schema}.documents (id serial primary key, name text not null);
      `);
      await db`insert into ${db(schema)}.documents (name) values (${name})`;
    }

    const readVia = (schema: string) =>
      db.begin(async (tx) => {
        await tx`select set_config('search_path', ${`${schema}, public`}, true)`;
        // Unqualified table name — resolves through search_path, exactly as
        // Drizzle's generated SQL does under withTenantSchema().
        return tx`select name from documents`;
      });

    expect((await readVia(`${ns}_sa`)).map((r) => r['name'])).toEqual(['alpha-doc']);
    expect((await readVia(`${ns}_sb`)).map((r) => r['name'])).toEqual(['bravo-doc']);

    // Outside the transactions the search_path is back to normal, so the
    // unqualified name no longer resolves — SET LOCAL did not leak.
    await expect(db`select name from documents`).rejects.toThrow(/does not exist/);
  });
});

// Silence the "declared but never used" warning for tenants: it is imported
// to assert the registry schema shape stays stable for resolver lookups.
describe('tenants registry table', () => {
  it('exposes id/name/slug/plan/created_at', () => {
    expect(tenants.id.name).toBe('id');
    expect(tenants.name.notNull).toBe(true);
    expect(tenants.slug.isUnique).toBe(true);
    expect(tenants.plan.default).toBe('free');
    expect(tenants.createdAt.name).toBe('created_at');
  });

  it('projects carries a non-null tenant_id FK', () => {
    expect(projects.tenantId.name).toBe('tenant_id');
    expect(projects.tenantId.notNull).toBe(true);
  });
});
