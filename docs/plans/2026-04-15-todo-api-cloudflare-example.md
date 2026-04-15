# Todo API (Cloudflare Workers) Example — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a complete example Todo API at `examples/todo-api-cloudflare/` demonstrating Nerva's Cloudflare Workers deployment path with CRUD endpoints, D1 database, Zod validation, and integration tests.

**Architecture:** Hono REST API with Cloudflare D1 (SQLite) via Drizzle ORM. Project structure mirrors what `setup-project.sh --cloudflare` generates, adapted for D1 instead of PostgreSQL. Integration tests use Miniflare for a real D1 instance and Hono's `app.request()` for HTTP-layer testing in standard Vitest.

**Tech Stack:** Hono, Drizzle ORM (`drizzle-orm/d1` + `drizzle-orm/sqlite-core`), Zod, `@hono/zod-validator`, Vitest, Miniflare (testing), Cloudflare Workers, TypeScript (strict mode)

**Key design decisions:**
- **D1 (SQLite)** instead of PostgreSQL — D1 is Cloudflare's native edge database; the schema uses `sqliteTable` from `drizzle-orm/sqlite-core`
- **Miniflare + `app.request()`** for tests — keeps standard Vitest config (close to shared template), tests run in Node.js with a real SQLite-backed D1 instance, coverage works normally
- **No `@cloudflare/vitest-pool-workers`** — simpler setup, more portable test patterns, same real-database benefit
- **Hand-written migration SQL** for D1 (applied via `wrangler d1 migrations apply`), with `drizzle.config.ts` included for future `drizzle-kit generate` use

---

## Final file tree

```
examples/todo-api-cloudflare/
├── README.md
└── api/
    ├── src/
    │   ├── index.ts              # Hono app: middleware + health + route mounting
    │   ├── routes/
    │   │   └── todos.ts          # Todo CRUD route handlers
    │   ├── db/
    │   │   └── schema.ts         # Drizzle schema (sqliteTable)
    │   └── types/
    │       └── todo.ts           # Zod validation schemas + inferred types
    ├── tests/
    │   ├── setup.ts              # Global test setup (no-op, matches template)
    │   ├── helpers.ts            # Miniflare D1 factory + seed helpers
    │   ├── unit/
    │   │   └── health.test.ts    # Health endpoint tests
    │   └── integration/
    │       └── todos.test.ts     # Todo CRUD integration tests
    ├── migrations/
    │   └── 0001_create_todos.sql # D1 migration
    ├── package.json
    ├── tsconfig.json
    ├── eslint.config.js          # Copied from shared template
    ├── prettier.config.js        # Copied from shared template
    ├── vitest.config.ts          # Based on shared template
    ├── wrangler.toml
    ├── drizzle.config.ts
    ├── .dev.vars.example
    └── .gitignore
```

---

## Task 1: Create directory structure and copy shared configs

**Files:**
- Create: `examples/todo-api-cloudflare/api/src/routes/` (directory)
- Create: `examples/todo-api-cloudflare/api/src/db/` (directory)
- Create: `examples/todo-api-cloudflare/api/src/types/` (directory)
- Create: `examples/todo-api-cloudflare/api/tests/unit/` (directory)
- Create: `examples/todo-api-cloudflare/api/tests/integration/` (directory)
- Create: `examples/todo-api-cloudflare/api/migrations/` (directory)
- Copy: `templates/shared/eslint.config.js` → `examples/todo-api-cloudflare/api/eslint.config.js`
- Copy: `templates/shared/prettier.config.js` → `examples/todo-api-cloudflare/api/prettier.config.js`

**Step 1: Create all directories**

```bash
mkdir -p examples/todo-api-cloudflare/api/src/{routes,db,types}
mkdir -p examples/todo-api-cloudflare/api/tests/{unit,integration}
mkdir -p examples/todo-api-cloudflare/api/migrations
```

**Step 2: Copy shared configs**

```bash
cp templates/shared/eslint.config.js examples/todo-api-cloudflare/api/eslint.config.js
cp templates/shared/prettier.config.js examples/todo-api-cloudflare/api/prettier.config.js
```

**Step 3: Commit**

```bash
git add examples/
git commit -m "chore: scaffold directory structure for todo-api-cloudflare example"
```

---

## Task 2: Create configuration files

**Files:**
- Create: `examples/todo-api-cloudflare/api/package.json`
- Create: `examples/todo-api-cloudflare/api/tsconfig.json`
- Create: `examples/todo-api-cloudflare/api/vitest.config.ts`
- Create: `examples/todo-api-cloudflare/api/wrangler.toml`
- Create: `examples/todo-api-cloudflare/api/drizzle.config.ts`
- Create: `examples/todo-api-cloudflare/api/.dev.vars.example`
- Create: `examples/todo-api-cloudflare/api/.gitignore`

**Step 1: Create package.json**

```json
{
  "name": "todo-api-cloudflare",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate:local": "wrangler d1 migrations apply todo-db --local",
    "db:migrate:remote": "wrangler d1 migrations apply todo-db --remote"
  }
}
```

Note differences from `setup-project.sh` output:
- `dev` → `wrangler dev` (not `tsx watch`)
- No `build`/`start` (Workers doesn't need them)
- Added `deploy`, `db:migrate:local`, `db:migrate:remote`
- Removed `db:push`, `db:studio`, `db:seed` (D1 uses wrangler migrations)

**Step 2: Create tsconfig.json**

Based on `templates/shared/tsconfig.json`, with Workers types added:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "types": ["@cloudflare/workers-types"],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.test.ts", "**/*.spec.ts"]
}
```

Only change from shared: added `"types": ["@cloudflare/workers-types"]` for global D1Database, KVNamespace, etc.

**Step 3: Create vitest.config.ts**

Based on `templates/shared/vitest.config.ts`, adapted for this project:

```typescript
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 10_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    pool: 'forks',
    reporters: ['verbose'],
  },
});
```

**Step 4: Create wrangler.toml**

Simplified from `templates/cloudflare-workers/wrangler.toml` — only D1 binding (no KV, no Hyperdrive):

```toml
name = "todo-api"
main = "src/index.ts"
compatibility_date = "2025-12-01"
compatibility_flags = ["nodejs_compat"]

[dev]
port = 8787
local_protocol = "http"

# D1 Database binding
# Create with: npx wrangler d1 create todo-db
# Then replace the database_id below
[[d1_databases]]
binding = "DB"
database_name = "todo-db"
database_id = "<YOUR_D1_DATABASE_ID>"

[vars]
ENVIRONMENT = "development"
```

**Step 5: Create drizzle.config.ts**

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
});
```

Key difference from template: `dialect: 'sqlite'` (not `'postgresql'`), no `dbCredentials`.

**Step 6: Create .dev.vars.example**

```
# .dev.vars — Cloudflare Workers local environment variables
# Copy this file to .dev.vars and fill in your values:
#   cp .dev.vars.example .dev.vars

ENVIRONMENT=development
```

**Step 7: Create .gitignore**

```
node_modules/
dist/
.env
.env.local
.env.*.local
*.log
.wrangler/
.dev.vars
coverage/
.DS_Store
```

**Step 8: Commit**

```bash
git add examples/todo-api-cloudflare/
git commit -m "chore: add configuration files for todo-api-cloudflare example"
```

---

## Task 3: Install dependencies

**Step 1: Install production dependencies**

```bash
cd examples/todo-api-cloudflare/api
pnpm add hono drizzle-orm zod @hono/zod-validator
```

Note: no `postgres` package (using D1 instead).

**Step 2: Install dev dependencies**

```bash
pnpm add -D vitest typescript eslint prettier drizzle-kit \
  @types/node @eslint/js typescript-eslint @vitest/coverage-v8 \
  wrangler miniflare @cloudflare/workers-types
```

Note: `miniflare` is an explicit dev dependency for tests. `@cloudflare/workers-types` provides global TypeScript types for D1Database, etc.

**Step 3: Verify installation**

```bash
pnpm typecheck
```

Expected: may fail (no source files yet) — that's fine, just confirms pnpm works.

**Step 4: Commit**

```bash
git add examples/todo-api-cloudflare/api/package.json examples/todo-api-cloudflare/api/pnpm-lock.yaml
git commit -m "chore: install dependencies for todo-api-cloudflare example"
```

---

## Task 4: Create schema layer (database + validation + migration)

**Files:**
- Create: `examples/todo-api-cloudflare/api/src/db/schema.ts`
- Create: `examples/todo-api-cloudflare/api/migrations/0001_create_todos.sql`
- Create: `examples/todo-api-cloudflare/api/src/types/todo.ts`

**Step 1: Create Drizzle schema**

File: `examples/todo-api-cloudflare/api/src/db/schema.ts`

```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const todos = sqliteTable('todos', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});
```

D1/SQLite notes:
- No UUID type — use `text` with `crypto.randomUUID()` via `$defaultFn`
- No TIMESTAMP type — use `text` with ISO strings
- No boolean type — use `integer` with `mode: 'boolean'` (stores 0/1, returns true/false)
- `$defaultFn` runs on the JavaScript side at insert time

**Step 2: Create D1 migration**

File: `examples/todo-api-cloudflare/api/migrations/0001_create_todos.sql`

```sql
-- Create todos table
CREATE TABLE `todos` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
```

This file is applied via `wrangler d1 migrations apply`. It can also be generated by `pnpm db:generate` — but we hand-write it here for clarity.

**Step 3: Create Zod validation schemas**

File: `examples/todo-api-cloudflare/api/src/types/todo.ts`

```typescript
import { z } from 'zod';

export const createTodoSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255, 'Title must be 255 characters or less'),
});

export const updateTodoSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255, 'Title must be 255 characters or less').optional(),
  completed: z.boolean().optional(),
});

export type CreateTodo = z.infer<typeof createTodoSchema>;
export type UpdateTodo = z.infer<typeof updateTodoSchema>;
```

**Step 4: Commit**

```bash
git add examples/todo-api-cloudflare/api/src/db/ examples/todo-api-cloudflare/api/src/types/ examples/todo-api-cloudflare/api/migrations/
git commit -m "feat: add Drizzle schema, D1 migration, and Zod validation for todos"
```

---

## Task 5: Create minimal app stub and test infrastructure

**Files:**
- Create: `examples/todo-api-cloudflare/api/src/index.ts` (stub)
- Create: `examples/todo-api-cloudflare/api/tests/setup.ts`
- Create: `examples/todo-api-cloudflare/api/tests/helpers.ts`

**Step 1: Create minimal app stub**

This is a bare-bones Hono app — just enough for tests to import. Routes are added later.

File: `examples/todo-api-cloudflare/api/src/index.ts`

```typescript
import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
};

const app = new Hono<{ Bindings: Bindings }>();

export default app;
```

**Step 2: Create test setup file**

File: `examples/todo-api-cloudflare/api/tests/setup.ts`

```typescript
import { beforeAll, afterAll } from 'vitest';

beforeAll(() => {
  // Global setup before all tests
});

afterAll(() => {
  // Global cleanup after all tests
});
```

Matches the template pattern from `setup-project.sh`.

**Step 3: Create test helpers**

File: `examples/todo-api-cloudflare/api/tests/helpers.ts`

```typescript
import { Miniflare } from 'miniflare';

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS todos (
  id text PRIMARY KEY NOT NULL,
  title text NOT NULL,
  completed integer DEFAULT 0 NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
`;

/**
 * Creates a Miniflare instance with a D1 database and applies the migration.
 * Returns the D1 binding and a cleanup function.
 */
export async function createTestDatabase(): Promise<{
  db: D1Database;
  cleanup: () => Promise<void>;
}> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(); } }',
    d1Databases: ['DB'],
  });

  const db = await mf.getD1Database('DB');
  await db.exec(MIGRATION_SQL);

  return {
    db,
    cleanup: () => mf.dispose(),
  };
}

/**
 * Inserts a todo directly into D1 for test setup.
 * Uses raw SQL to avoid coupling to the app layer.
 */
export async function seedTodo(
  db: D1Database,
  id: string,
  title: string,
  completed = 0,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO todos (id, title, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(id, title, completed, now, now)
    .run();
}
```

**Step 4: Commit**

```bash
git add examples/todo-api-cloudflare/api/src/index.ts examples/todo-api-cloudflare/api/tests/
git commit -m "chore: add minimal app stub and test infrastructure"
```

---

## Task 6: Write failing health endpoint tests (RED)

**Files:**
- Create: `examples/todo-api-cloudflare/api/tests/unit/health.test.ts`

**Step 1: Write health endpoint tests**

File: `examples/todo-api-cloudflare/api/tests/unit/health.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import app from '../../src/index';

describe('Health endpoint', () => {
  it('should return 200 with ok status', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('should include a requestId in the response body', async () => {
    const res = await app.request('/health');
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBeDefined();
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it('should include X-Request-Id response header', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('X-Request-Id')).not.toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd examples/todo-api-cloudflare/api
pnpm test
```

Expected: FAIL — health route not implemented yet, `GET /health` returns 404.

**Step 3: Commit**

```bash
git add examples/todo-api-cloudflare/api/tests/unit/health.test.ts
git commit -m "test: add failing health endpoint tests (RED)"
```

---

## Task 7: Write failing todo CRUD integration tests (RED)

**Files:**
- Create: `examples/todo-api-cloudflare/api/tests/integration/todos.test.ts`

**Step 1: Write integration tests**

File: `examples/todo-api-cloudflare/api/tests/integration/todos.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import app from '../../src/index';
import { createTestDatabase, seedTodo } from '../helpers';

interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

let db: D1Database;
let cleanup: () => Promise<void>;

const env = (): { DB: D1Database; ENVIRONMENT: string } => ({
  DB: db,
  ENVIRONMENT: 'test',
});

beforeAll(async () => {
  const testDb = await createTestDatabase();
  db = testDb.db;
  cleanup = testDb.cleanup;
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await db.exec('DELETE FROM todos');
});

// ---------- GET /todos ----------

describe('GET /todos', () => {
  it('returns empty array when no todos exist', async () => {
    const res = await app.request('/todos', {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todos: TodoItem[]; total: number };
    expect(body.todos).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns all todos', async () => {
    await seedTodo(db, 'id-1', 'First todo');
    await seedTodo(db, 'id-2', 'Second todo');

    const res = await app.request('/todos', {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todos: TodoItem[]; total: number };
    expect(body.total).toBe(2);
    expect(body.todos).toHaveLength(2);
  });
});

// ---------- POST /todos ----------

describe('POST /todos', () => {
  it('creates a new todo', async () => {
    const res = await app.request(
      '/todos',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Buy groceries' }),
      },
      env(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as TodoItem;
    expect(body.title).toBe('Buy groceries');
    expect(body.completed).toBe(false);
    expect(body.id).toBeDefined();
    expect(body.createdAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
  });

  it('returns 400 when title is missing', async () => {
    const res = await app.request(
      '/todos',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when title is empty string', async () => {
    const res = await app.request(
      '/todos',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '' }),
      },
      env(),
    );
    expect(res.status).toBe(400);
  });
});

// ---------- GET /todos/:id ----------

describe('GET /todos/:id', () => {
  it('returns a specific todo', async () => {
    await seedTodo(db, 'find-me', 'Found todo');

    const res = await app.request('/todos/find-me', {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as TodoItem;
    expect(body.id).toBe('find-me');
    expect(body.title).toBe('Found todo');
    expect(body.completed).toBe(false);
  });

  it('returns 404 for non-existent todo', async () => {
    const res = await app.request('/todos/does-not-exist', {}, env());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Todo not found');
  });
});

// ---------- PUT /todos/:id ----------

describe('PUT /todos/:id', () => {
  it('updates a todo title', async () => {
    await seedTodo(db, 'update-title', 'Old title');

    const res = await app.request(
      '/todos/update-title',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New title' }),
      },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TodoItem;
    expect(body.title).toBe('New title');
    expect(body.id).toBe('update-title');
  });

  it('updates a todo completed status', async () => {
    await seedTodo(db, 'complete-me', 'Some task');

    const res = await app.request(
      '/todos/complete-me',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TodoItem;
    expect(body.completed).toBe(true);
  });

  it('returns 404 for non-existent todo', async () => {
    const res = await app.request(
      '/todos/does-not-exist',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      },
      env(),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Todo not found');
  });
});

// ---------- DELETE /todos/:id ----------

describe('DELETE /todos/:id', () => {
  it('deletes a todo', async () => {
    await seedTodo(db, 'delete-me', 'Goodbye');

    const res = await app.request('/todos/delete-me', { method: 'DELETE' }, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('Todo deleted');

    // Verify it's actually gone
    const verifyRes = await app.request('/todos/delete-me', {}, env());
    expect(verifyRes.status).toBe(404);
  });

  it('returns 404 for non-existent todo', async () => {
    const res = await app.request('/todos/does-not-exist', { method: 'DELETE' }, env());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Todo not found');
  });
});
```

Total: 12 CRUD tests covering happy paths, validation errors, and 404s.

**Step 2: Run tests to verify they fail**

```bash
cd examples/todo-api-cloudflare/api
pnpm test
```

Expected: FAIL — all todo routes return 404 (not implemented yet). The test file should load and attempt to run, but every assertion on `/todos*` should fail.

**Step 3: Commit**

```bash
git add examples/todo-api-cloudflare/api/tests/integration/todos.test.ts
git commit -m "test: add failing todo CRUD integration tests (RED)"
```

---

## Task 8: Implement health endpoint and main app (GREEN — partial)

**Files:**
- Modify: `examples/todo-api-cloudflare/api/src/index.ts`

**Step 1: Implement full index.ts with middleware and health endpoint**

Replace the stub with the full implementation:

File: `examples/todo-api-cloudflare/api/src/index.ts`

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { todosRoutes } from './routes/todos';
// Note: Response compression is handled automatically by Cloudflare's edge network.
// No compress() middleware is needed for Workers deployments.

type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// --- Middleware ---
app.use('*', logger());
app.use('*', cors());
app.use('*', etag());
app.use('*', secureHeaders());
app.use('*', requestId());

// --- Health check ---
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    requestId: c.get('requestId'),
    timestamp: new Date().toISOString(),
  });
});

// --- Routes ---
app.route('/todos', todosRoutes);

// --- Root ---
app.get('/', (c) => {
  return c.json({ message: 'Todo API', version: '0.0.1' });
});

export default app;
```

Note: This imports `todosRoutes` which doesn't exist yet. That's intentional — we implement it in Task 9. For now this file will have a TypeScript error, which is expected in TDD.

**Step 2: Run health tests only**

```bash
cd examples/todo-api-cloudflare/api
pnpm vitest run tests/unit/health.test.ts
```

Expected: this will fail because `./routes/todos` doesn't exist yet. Create a minimal stub:

File: `examples/todo-api-cloudflare/api/src/routes/todos.ts` (stub)

```typescript
import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
};

export const todosRoutes = new Hono<{ Bindings: Bindings }>();
```

**Step 3: Run health tests again**

```bash
pnpm vitest run tests/unit/health.test.ts
```

Expected: PASS — all 3 health tests should pass.

**Step 4: Run all tests**

```bash
pnpm test
```

Expected: health tests PASS, CRUD tests FAIL (routes are empty stubs). This confirms we're in a proper RED state for CRUD.

**Step 5: Commit**

```bash
git add examples/todo-api-cloudflare/api/src/
git commit -m "feat: implement health endpoint and middleware stack (health tests GREEN)"
```

---

## Task 9: Implement todo CRUD route handlers (GREEN)

**Files:**
- Modify: `examples/todo-api-cloudflare/api/src/routes/todos.ts`

**Step 1: Implement all CRUD routes**

Replace the stub with the full implementation:

File: `examples/todo-api-cloudflare/api/src/routes/todos.ts`

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { todos } from '../db/schema';
import { createTodoSchema, updateTodoSchema } from '../types/todo';

type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
};

export const todosRoutes = new Hono<{ Bindings: Bindings }>()
  // GET /todos — List all todos
  .get('/', async (c) => {
    const db = drizzle(c.env.DB);
    const allTodos = await db.select().from(todos);
    return c.json({ todos: allTodos, total: allTodos.length });
  })

  // POST /todos — Create a new todo
  .post('/', zValidator('json', createTodoSchema), async (c) => {
    const db = drizzle(c.env.DB);
    const body = c.req.valid('json');
    const result = await db.insert(todos).values({ title: body.title }).returning();
    const newTodo = result[0];
    if (!newTodo) {
      return c.json({ error: 'Failed to create todo' }, 500);
    }
    return c.json(newTodo, 201);
  })

  // GET /todos/:id — Get a specific todo
  .get('/:id', async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param('id');
    const result = await db.select().from(todos).where(eq(todos.id, id));
    const todo = result[0];
    if (!todo) {
      return c.json({ error: 'Todo not found' }, 404);
    }
    return c.json(todo);
  })

  // PUT /todos/:id — Update a todo
  .put('/:id', zValidator('json', updateTodoSchema), async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const result = await db
      .update(todos)
      .set({ ...body, updatedAt: new Date().toISOString() })
      .where(eq(todos.id, id))
      .returning();
    const updated = result[0];
    if (!updated) {
      return c.json({ error: 'Todo not found' }, 404);
    }
    return c.json(updated);
  })

  // DELETE /todos/:id — Delete a todo
  .delete('/:id', async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param('id');
    const result = await db.delete(todos).where(eq(todos.id, id)).returning();
    const deleted = result[0];
    if (!deleted) {
      return c.json({ error: 'Todo not found' }, 404);
    }
    return c.json({ message: 'Todo deleted' });
  });
```

Key patterns:
- Each handler creates a Drizzle instance from `c.env.DB` (D1 binding)
- `zValidator('json', schema)` handles request validation and returns 400 automatically
- `.returning()` retrieves the affected row; `result[0]` is checked for `undefined` (type-safe with `noUncheckedIndexedAccess`)
- `$defaultFn` on the schema generates `id`, `createdAt`, `updatedAt` at insert time

**Step 2: Run all tests**

```bash
cd examples/todo-api-cloudflare/api
pnpm test
```

Expected: ALL 15 tests PASS (3 health + 12 CRUD).

**Step 3: If any tests fail, diagnose and fix**

Common issues to check:
- D1 `RETURNING` clause support — if Drizzle/D1 doesn't support `.returning()`, switch to insert-then-select pattern
- Boolean mode mapping — ensure `integer('completed', { mode: 'boolean' })` returns `true`/`false` (not `0`/`1`) in the response
- Timestamp format — ensure `createdAt`/`updatedAt` are ISO strings in the response
- Miniflare D1 API compatibility — if `getD1Database` returns a different type, adjust `tests/helpers.ts`

**Step 4: Commit**

```bash
git add examples/todo-api-cloudflare/api/src/routes/todos.ts
git commit -m "feat: implement todo CRUD route handlers (all tests GREEN)"
```

---

## Task 10: Write example README

**Files:**
- Create: `examples/todo-api-cloudflare/README.md`

**Step 1: Write README**

File: `examples/todo-api-cloudflare/README.md`

```markdown
# Todo API — Cloudflare Workers Example

A complete REST API for managing todos, built with [Nerva](../../README.md) and deployed to Cloudflare Workers.

This example demonstrates:

- **Hono** HTTP framework with middleware (CORS, security headers, request ID, ETag)
- **Drizzle ORM** with Cloudflare D1 (SQLite at the edge)
- **Zod** request validation via `@hono/zod-validator`
- **Vitest** integration tests with Miniflare D1
- **TypeScript** strict mode

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 9+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency)

## Setup

```bash
cd examples/todo-api-cloudflare/api
pnpm install

# Apply the D1 migration to the local database
pnpm db:migrate:local

# Start the development server
pnpm dev
```

The API is now running at `http://localhost:8787`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/todos` | List all todos |
| `POST` | `/todos` | Create a new todo |
| `GET` | `/todos/:id` | Get a specific todo |
| `PUT` | `/todos/:id` | Update a todo |
| `DELETE` | `/todos/:id` | Delete a todo |

### Examples

**Create a todo:**

```bash
curl -X POST http://localhost:8787/todos \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy groceries"}'
```

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "Buy groceries",
  "completed": false,
  "createdAt": "2026-04-15T10:30:00.000Z",
  "updatedAt": "2026-04-15T10:30:00.000Z"
}
```

**List all todos:**

```bash
curl http://localhost:8787/todos
```

```json
{
  "todos": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "title": "Buy groceries",
      "completed": false,
      "createdAt": "2026-04-15T10:30:00.000Z",
      "updatedAt": "2026-04-15T10:30:00.000Z"
    }
  ],
  "total": 1
}
```

**Mark a todo as completed:**

```bash
curl -X PUT http://localhost:8787/todos/550e8400-e29b-41d4-a716-446655440000 \
  -H "Content-Type: application/json" \
  -d '{"completed": true}'
```

**Delete a todo:**

```bash
curl -X DELETE http://localhost:8787/todos/550e8400-e29b-41d4-a716-446655440000
```

### Validation

Requests are validated with Zod. Invalid requests return `400`:

```bash
# Missing required title
curl -X POST http://localhost:8787/todos \
  -H "Content-Type: application/json" \
  -d '{}'
# → 400 Bad Request
```

## Testing

```bash
pnpm test              # Run all tests
pnpm test:watch        # Run in watch mode
pnpm test:coverage     # Run with coverage report
```

Tests use Miniflare to provide a real D1 (SQLite) database instance. No mocking — queries run against actual SQLite.

## Deploy to Cloudflare Workers

1. Create a D1 database:

```bash
npx wrangler d1 create todo-db
```

2. Update `wrangler.toml` with the database ID from the output.

3. Apply the migration to the remote D1 database:

```bash
pnpm db:migrate:remote
```

4. Deploy:

```bash
pnpm deploy
```

## Project Structure

```
api/
├── src/
│   ├── index.ts          # App entry: middleware + health + route mounting
│   ├── routes/
│   │   └── todos.ts      # Todo CRUD handlers (Hono + Drizzle + Zod)
│   ├── db/
│   │   └── schema.ts     # Drizzle schema (sqliteTable for D1)
│   └── types/
│       └── todo.ts       # Zod validation schemas + TypeScript types
├── tests/
│   ├── helpers.ts        # Miniflare D1 factory + seed helpers
│   ├── unit/
│   │   └── health.test.ts
│   └── integration/
│       └── todos.test.ts
├── migrations/
│   └── 0001_create_todos.sql
├── wrangler.toml         # Cloudflare Workers + D1 config
└── drizzle.config.ts     # Drizzle Kit config (for generating migrations)
```

## How This Was Built

This example follows the structure generated by Nerva's setup script:

```bash
./scripts/setup-project.sh todo-api --cloudflare
```

Then adapted for D1 (SQLite) instead of PostgreSQL:

- Schema uses `sqliteTable` from `drizzle-orm/sqlite-core`
- Drizzle config uses `dialect: 'sqlite'`
- Migrations are applied via `wrangler d1 migrations apply`
- Tests use Miniflare for a real D1 instance
```

**Step 2: Commit**

```bash
git add examples/todo-api-cloudflare/README.md
git commit -m "docs: add README for todo-api-cloudflare example"
```

---

## Task 11: Add link to main README

**Files:**
- Modify: `README.md` (project root)

**Step 1: Add example link to Quick Start section**

In the root `README.md`, find the Quick Start section (around line 30-43). Add a link after the code block:

```markdown
## Quick Start

```bash
# Clone the repository
git clone https://github.com/PMDevSolutions/Nerva.git
cd Nerva
pnpm install

# Initialize a new API project
./scripts/setup-project.sh my-api --cloudflare   # or --node

# Start development
cd api && pnpm dev
```

> **New to Nerva?** See the [Todo API example](examples/todo-api-cloudflare/) for a complete working Cloudflare Workers project with CRUD, D1, Zod validation, and tests.
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add todo-api-cloudflare example link to Quick Start section"
```

---

## Task 12: Final verification

**Step 1: TypeScript check**

```bash
cd examples/todo-api-cloudflare/api
pnpm typecheck
```

Expected: no errors. If there are errors, fix them (common issues: missing types, import extensions, strict mode violations).

**Step 2: Lint**

```bash
pnpm lint
```

Expected: no errors. If there are lint errors, fix with `pnpm lint:fix` for auto-fixable ones, manually fix others.

**Step 3: Run all tests one final time**

```bash
pnpm test
```

Expected: ALL 15 tests PASS.

```
 ✓ tests/unit/health.test.ts (3 tests)
 ✓ tests/integration/todos.test.ts (12 tests)

 Test Files  2 passed (2)
      Tests  15 passed (15)
```

**Step 4: Verify from repo root**

```bash
cd /path/to/Nerva
ls examples/todo-api-cloudflare/
ls examples/todo-api-cloudflare/api/src/
```

Confirm the file tree matches the plan.

**Step 5: Final commit (if any fixes were needed)**

```bash
git add examples/todo-api-cloudflare/
git commit -m "fix: resolve typecheck and lint issues in todo-api-cloudflare example"
```
