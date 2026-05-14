# Health endpoint with dependency checks — design & implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Issue:** #54
**Goal:** Replace the static `{ status: 'ok' }` health endpoint in `setup-project.sh` with a real liveness check that pings the database, reports version and uptime, and returns `503` when a dependency is down. Apply to both Cloudflare Workers and Node.js templates and mirror in `examples/todo-api-cloudflare`.

---

## Response shape

Healthy (HTTP `200`):

```json
{
  "status": "healthy",
  "version": "0.0.1",
  "uptime": 3600,
  "timestamp": "2026-04-08T12:00:00Z",
  "requestId": "01HXYZ...",
  "checks": { "database": "connected" }
}
```

Unhealthy (HTTP `503`): same shape with `status: "unhealthy"` and the failing check set to `"disconnected"`.

`checks` is an object so future dependencies (Redis, S3, external API) drop in as `checks.redis: "connected"` without breaking consumers. Overall `status` is `"unhealthy"` if any check is `"disconnected"`.

---

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Uptime on Workers | `Date.now() - startTime` captured at module load | Honest about isolate semantics; zero cost; no extra bindings |
| Version source | `APP_VERSION` env var (both templates) | One pattern across Workers and Node; deploys can override |
| File layout | `src/routes/health.ts` + `src/db/ping.ts` | Matches existing route-extraction pattern (e.g. `routes/todos.ts`); keeps `index.ts` tidy |
| DB ping timeout | 2 s default, `HEALTH_DB_TIMEOUT_MS` overrides | Well under k8s `livenessProbe` default (10 s) and Workers CPU budget |
| Missing binding/env | Counts as `disconnected` | A config-level outage is still an outage from the prober's view |
| Internal throw | Caught and returned as `503` | Health endpoint must never `500` — load balancers treat `5xx` as "needs restart" |
| Node DB connection | New `src/db/client.ts` singleton; refactor `seed.ts` to import it | First feature to need a shared client; pays off for future routes too |

---

## File tree (deltas, both templates unless noted)

```
api/
├── src/
│   ├── index.ts                # MODIFIED: mount healthRoutes
│   ├── routes/
│   │   └── health.ts           # NEW
│   └── db/
│       ├── client.ts           # NEW (Node only)
│       ├── ping.ts             # NEW (template-specific body)
│       └── seed.ts             # MODIFIED (Node only): import client
├── tests/
│   └── unit/
│       └── health.test.ts      # EXPANDED
├── .dev.vars.example           # Workers: + APP_VERSION, HEALTH_DB_TIMEOUT_MS
├── .env.example                # Node:    + APP_VERSION, HEALTH_DB_TIMEOUT_MS
└── wrangler.toml               # Workers: APP_VERSION in [vars]
```

---

## Task 1: Add Node `src/db/client.ts` shared singleton, refactor `seed.ts`

**Setup-project.sh changes (Node branch only):**

Add a `write_file "$API_DIR/src/db/client.ts"` block:

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const client = postgres(databaseUrl);
export const db = drizzle(client, { schema });
```

Refactor `seed.ts` to import `client` and `db` from `./client.js` instead of constructing its own `postgres()` call. Keep `client.end()` at the end of `seed()`.

**Verify:** generate a Node project, run `pnpm db:seed` — must connect and seed without errors.

**Commit:** `refactor(template): extract shared postgres client for Node template`

---

## Task 2: Add `src/db/ping.ts` to both templates

**Workers branch:**

```typescript
import type { Context } from 'hono';
import postgres from 'postgres';

type Bindings = { HYPERDRIVE: Hyperdrive };

export async function pingDatabase(c: Context<{ Bindings: Bindings }>): Promise<'connected' | 'disconnected'> {
  if (!c.env.HYPERDRIVE?.connectionString) return 'disconnected';
  const sql = postgres(c.env.HYPERDRIVE.connectionString, { max: 1, fetch_types: false });
  try {
    await sql`SELECT 1`;
    return 'connected';
  } catch {
    return 'disconnected';
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}
```

**Node branch:**

```typescript
import { client } from './client.js';

export async function pingDatabase(): Promise<'connected' | 'disconnected'> {
  try {
    await client`SELECT 1`;
    return 'connected';
  } catch {
    return 'disconnected';
  }
}
```

**Commit:** `feat(template): add pingDatabase helper for health checks`

---

## Task 3: Add `src/routes/health.ts` to both templates

Common skeleton (Workers shown; Node omits the `c` arg to `pingDatabase()`):

```typescript
import { Hono } from 'hono';
import { pingDatabase } from '../db/ping';

const startTime = Date.now();

type Bindings = {
  APP_VERSION: string;
  HEALTH_DB_TIMEOUT_MS: string;
  HYPERDRIVE: Hyperdrive;
};

export const healthRoutes = new Hono<{ Bindings: Bindings }>().get('/', async (c) => {
  const timeoutMs = Number(c.env.HEALTH_DB_TIMEOUT_MS ?? 2000);
  const timeout = new Promise<'disconnected'>((resolve) =>
    setTimeout(() => resolve('disconnected'), timeoutMs),
  );

  let database: 'connected' | 'disconnected';
  try {
    database = await Promise.race([pingDatabase(c), timeout]);
  } catch {
    database = 'disconnected';
  }

  const status = database === 'connected' ? 'healthy' : 'unhealthy';
  const body = {
    status,
    version: c.env.APP_VERSION ?? 'unknown',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    requestId: c.get('requestId'),
    checks: { database },
  };
  return c.json(body, status === 'healthy' ? 200 : 503);
});
```

**Wire into `index.ts`** (both templates): replace the inline `app.get('/health', ...)` with:

```typescript
import { healthRoutes } from './routes/health';
// ...
app.route('/health', healthRoutes);
```

**Commit:** `feat(template): replace static /health with dependency-checking handler`

---

## Task 4: Update env/config templates

**Workers (`.dev.vars.example`):**

```
APP_VERSION=0.0.1
HEALTH_DB_TIMEOUT_MS=2000
```

**Workers (`wrangler.toml` `[vars]` block):**

```toml
[vars]
ENVIRONMENT = "development"
APP_VERSION = "0.0.1"
HEALTH_DB_TIMEOUT_MS = "2000"
```

**Node (`.env.example`):**

```
APP_VERSION=0.0.1
HEALTH_DB_TIMEOUT_MS=2000
```

**Commit:** `chore(template): add APP_VERSION and HEALTH_DB_TIMEOUT_MS to env templates`

---

## Task 5: Expand `tests/unit/health.test.ts`

Test cases (both templates):

1. **Healthy path** — `pingDatabase` mocked → `'connected'`. Asserts `status: 'healthy'`, `checks.database: 'connected'`, HTTP `200`.
2. **Version from env** — `APP_VERSION=0.0.1` in test env. Asserts `body.version === '0.0.1'`.
3. **Uptime numeric** — Asserts `typeof body.uptime === 'number'` and `body.uptime >= 0`.
4. **Unhealthy when DB disconnected** — `pingDatabase` mocked → `'disconnected'`. Asserts `status: 'unhealthy'`, `checks.database: 'disconnected'`, HTTP `503`.
5. **Unhealthy on timeout** — `pingDatabase` mocked to return a never-resolving promise; fake timers advance past `HEALTH_DB_TIMEOUT_MS`. Asserts `503`.
6. **Unhealthy on thrown error** — `pingDatabase` mocked to throw. Asserts `503` (never `500`).
7. **Preserves requestId + X-Request-Id header** — keeps the existing three assertions but updates the status assertion from `'ok'` → `'healthy'`.

Use `vi.mock('../../src/db/ping')` to swap `pingDatabase`. No real postgres needed in CI.

**Commit:** `test(template): cover health endpoint dependency status, timeout, and error paths`

---

## Task 6: Mirror in `examples/todo-api-cloudflare`

This example has its own `src/index.ts`, `src/routes/`, and `tests/unit/health.test.ts`. Apply Tasks 2, 3, and 5 to the example (its DB is D1, not Hyperdrive, so `pingDatabase` uses `c.env.DB.prepare('SELECT 1').first()` instead of `postgres()`).

Update `wrangler.toml` `[vars]` and `.dev.vars.example` in the example accordingly.

**Commit:** `feat(example): wire dependency-checking /health into todo-api-cloudflare`

---

## Task 7: Smoke-test generated templates

```bash
# Node smoke test
./scripts/setup-project.sh /tmp/nerva-health-node --node
cd /tmp/nerva-health-node && pnpm install && pnpm typecheck && pnpm test

# Workers smoke test
./scripts/setup-project.sh /tmp/nerva-health-cf --cloudflare
cd /tmp/nerva-health-cf && pnpm install && pnpm typecheck && pnpm test
```

Both must pass typecheck and the health tests. If a generated project doesn't compile, fix the template — not the generated output.

**Verify also:** existing CI matrix (`Node.js 20 Compatibility`, `Node.js 22 Compatibility`, `Check Markdown Links`, `Validate Structure`) passes on the PR.

---

## Out of scope

- Separate `/health/live` vs `/health/ready` (k8s-style split) — single endpoint matches the issue's example response.
- External-service checks beyond DB — pattern is in place for future additions.
- Auto-injecting `APP_VERSION` from `package.json` at build time — env var pattern is the contract; build-time substitution is a follow-up.
