---
name: tdd-from-schema
description: >
  Writes failing integration tests BEFORE route handlers exist, following strict
  test-driven development. For every endpoint in build-spec.json, generates Vitest
  integration tests covering happy paths, validation errors, auth requirements, and
  edge cases. Tests must be confirmed RED before Phase 3 proceeds. This is a hard
  gate in the Nerva pipeline. Keywords: tdd, test, vitest, integration, red-green,
  failing-tests, supertest, test-driven, crud-tests, validation-test, auth-test,
  coverage, testcontainers, test-database, hard-gate
---

# TDD from Schema (Phase 2)

## Purpose

Generates a comprehensive suite of failing integration tests for every endpoint
defined in `build-spec.json`. These tests exercise the full HTTP stack using the
Hono test client, validating response shapes, status codes, error formats,
authentication requirements, and pagination behaviour. All tests must be confirmed
RED (failing) before route generation begins. This is a **hard gate** in the
Nerva pipeline.

## When to Use

- Phase 1 (database-design) is complete and Drizzle schemas exist.
- The user is ready to start implementing routes via TDD.
- The user says "write tests", "tdd", "red phase", or "test first".
- Before any route handler code is written.

## Inputs

| Input | Required | Description |
|---|---|---|
| `build-spec.json` | Yes | `.claude/plans/build-spec.json` with endpoints and auth config |
| Drizzle schemas | Yes | `api/src/db/schema/*.ts` from Phase 1 |
| Zod validators | Yes | `api/src/validators/*.ts` from Phase 1 |

## Steps

### Step 1 -- Set Up Test Infrastructure

Install test dependencies:

```bash
cd api && pnpm add -D vitest @vitest/coverage-v8 supertest @types/supertest testcontainers @testcontainers/postgresql
```

Create the Vitest configuration:

```typescript
// api/vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['./tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/db/migrations/**'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

### Step 2 -- Create Test Setup with Database Container

```typescript
// api/tests/setup.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from '../src/db/schema';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;

export let testDb: ReturnType<typeof drizzle>;

beforeAll(async () => {
  // Start PostgreSQL container
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('test_db')
    .withUsername('test')
    .withPassword('test')
    .start();

  const connectionString = container.getConnectionUri();
  client = postgres(connectionString);
  testDb = drizzle(client, { schema });

  // Run migrations
  await migrate(testDb, {
    migrationsFolder: './src/db/migrations',
  });
}, 60000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

// Clean tables between tests
afterEach(async () => {
  await testDb.execute(
    `TRUNCATE TABLE order_items, orders, books, users RESTART IDENTITY CASCADE`,
  );
});
```

### Step 3 -- Create Test Helpers

```typescript
// api/tests/helpers/index.ts
import { testDb } from '../setup';
import { users, books, orders, orderItems } from '../../src/db/schema';
import { SignJWT } from 'jose';

const JWT_SECRET = new TextEncoder().encode('test-secret-key-at-least-32-chars!!');

// Factory functions
export async function createTestUser(
  overrides: Partial<typeof users.$inferInsert> = {},
) {
  const [user] = await testDb
    .insert(users)
    .values({
      email: `test-${Date.now()}@example.com`,
      passwordHash: '$2b$10$hashedpassword',
      name: 'Test User',
      role: 'customer',
      ...overrides,
    })
    .returning();
  return user;
}

export async function createTestAdmin() {
  return createTestUser({
    role: 'admin',
    email: `admin-${Date.now()}@example.com`,
  });
}

export async function createTestBook(
  overrides: Partial<typeof books.$inferInsert> = {},
) {
  const [book] = await testDb
    .insert(books)
    .values({
      title: 'Test Book',
      author: 'Test Author',
      isbn: `978${Date.now().toString().slice(-10)}`,
      price: '19.99',
      stock: 10,
      ...overrides,
    })
    .returning();
  return book;
}

export async function createTestOrder(
  userId: string,
  items: { bookId: string; quantity: number }[] = [],
) {
  const [order] = await testDb
    .insert(orders)
    .values({
      userId,
      status: 'pending',
      total: '0.00',
    })
    .returning();

  for (const item of items) {
    const book = await testDb.query.books.findFirst({
      where: (b, { eq }) => eq(b.id, item.bookId),
    });
    await testDb.insert(orderItems).values({
      orderId: order.id,
      bookId: item.bookId,
      quantity: item.quantity,
      unitPrice: book?.price ?? '0.00',
    });
  }

  return order;
}

// Auth helpers
export async function generateTestToken(
  userId: string,
  role: string = 'customer',
): Promise<string> {
  const token = await new SignJWT({ sub: userId, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .setIssuedAt()
    .sign(JWT_SECRET);
  return token;
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// Response shape assertions
export function expectPaginatedResponse(body: any) {
  expect(body).toHaveProperty('data');
  expect(body).toHaveProperty('meta');
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.meta).toHaveProperty('page');
  expect(body.meta).toHaveProperty('limit');
  expect(body.meta).toHaveProperty('total');
  expect(body.meta).toHaveProperty('totalPages');
}

export function expectValidationError(body: any) {
  expect(body).toHaveProperty('error');
  expect(body.error).toHaveProperty('code', 'VALIDATION_ERROR');
  expect(body.error).toHaveProperty('details');
  expect(Array.isArray(body.error.details)).toBe(true);
}

export function expectNotFoundError(body: any) {
  expect(body).toHaveProperty('error');
  expect(body.error).toHaveProperty('code', 'NOT_FOUND');
}

// Snapshot normalizers -- strip volatile values so snapshots stay stable
// across runs without losing the ability to detect schema drift.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export function normalizeForSnapshot(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(normalizeForSnapshot);
  if (typeof value === 'string') {
    if (UUID_RE.test(value)) return '<uuid>';
    if (ISO_DATE_RE.test(value)) return '<iso-date>';
    return value;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = normalizeForSnapshot((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// Snapshot just the *shape* of a response (sorted top-level keys) -- catches
// added/removed fields without coupling to values that legitimately change.
export function responseShape(body: unknown): string[] {
  if (body === null || typeof body !== 'object') return [];
  return Object.keys(body as object).sort();
}

// Pick the headers we actually care about for contract stability. Vary the
// list per route group if you add custom headers (e.g. X-RateLimit-*).
export function snapshotHeaders(
  res: Response,
  extra: string[] = [],
): Record<string, string | null> {
  const keys = ['content-type', 'cache-control', 'vary', ...extra];
  const out: Record<string, string | null> = {};
  for (const key of keys) out[key] = res.headers.get(key);
  return out;
}
```

### Step 4 -- Create the Hono Test App Helper

```typescript
// api/tests/helpers/app.ts
import { testDb } from '../setup';
import { createApp } from '../../src/app';

export function getTestApp() {
  return createApp({ db: testDb });
}
```

### Step 5 -- Generate CRUD Tests for Each Resource

For each resource in build-spec.json, generate a test file covering all endpoints.

**Example: Books CRUD Tests**

```typescript
// api/tests/routes/books.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getTestApp } from '../helpers/app';
import {
  createTestAdmin,
  createTestBook,
  createTestUser,
  generateTestToken,
  authHeader,
  expectPaginatedResponse,
  expectValidationError,
  expectNotFoundError,
} from '../helpers';

describe('Books API', () => {
  let app: ReturnType<typeof getTestApp>;

  beforeEach(() => {
    app = getTestApp();
  });

  // --- LIST BOOKS ---
  describe('GET /books', () => {
    it('should return a paginated list of books', async () => {
      await createTestBook({ title: 'Book A' });
      await createTestBook({ title: 'Book B' });

      const res = await app.request('/books');
      const body = await res.json();

      expect(res.status).toBe(200);
      expectPaginatedResponse(body);
      expect(body.data).toHaveLength(2);
    });

    it('should return empty data array when no books exist', async () => {
      const res = await app.request('/books');
      const body = await res.json();

      expect(res.status).toBe(200);
      expectPaginatedResponse(body);
      expect(body.data).toHaveLength(0);
      expect(body.meta.total).toBe(0);
    });

    it('should respect pagination parameters', async () => {
      for (let i = 0; i < 25; i++) {
        await createTestBook({
          title: `Book ${i}`,
          isbn: `978000000${i.toString().padStart(4, '0')}`,
        });
      }

      const res = await app.request('/books?page=2&limit=10');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(10);
      expect(body.meta.page).toBe(2);
      expect(body.meta.totalPages).toBe(3);
    });

    it('should reject invalid pagination params', async () => {
      const res = await app.request('/books?page=-1');
      expect(res.status).toBe(400);
    });

    it('should not require authentication', async () => {
      const res = await app.request('/books');
      expect(res.status).not.toBe(401);
    });
  });

  // --- GET BOOK BY ID ---
  describe('GET /books/:id', () => {
    it('should return a book by ID', async () => {
      const book = await createTestBook();

      const res = await app.request(`/books/${book.id}`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.id).toBe(book.id);
      expect(body.title).toBe(book.title);
      expect(body.author).toBe(book.author);
    });

    it('should return 404 for non-existent book', async () => {
      const res = await app.request(
        '/books/00000000-0000-0000-0000-000000000000',
      );
      const body = await res.json();

      expect(res.status).toBe(404);
      expectNotFoundError(body);
    });

    it('should return 400 for invalid UUID', async () => {
      const res = await app.request('/books/not-a-uuid');
      expect(res.status).toBe(400);
    });
  });

  // --- CREATE BOOK ---
  describe('POST /books', () => {
    it('should create a book when authenticated as admin', async () => {
      const admin = await createTestAdmin();
      const token = await generateTestToken(admin.id, 'admin');

      const bookData = {
        title: 'New Book',
        author: 'New Author',
        isbn: '9780000000001',
        price: '29.99',
        stock: 5,
      };

      const res = await app.request('/books', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(token),
        },
        body: JSON.stringify(bookData),
      });
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.title).toBe(bookData.title);
      expect(body.id).toBeDefined();
      expect(body.createdAt).toBeDefined();
    });

    it('should return 401 when not authenticated', async () => {
      const res = await app.request('/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Book',
          author: 'Author',
          isbn: '9780000000002',
          price: '10.00',
        }),
      });

      expect(res.status).toBe(401);
    });

    it('should return 403 when authenticated as non-admin', async () => {
      const user = await createTestUser();
      const token = await generateTestToken(user.id, 'customer');

      const res = await app.request('/books', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(token),
        },
        body: JSON.stringify({
          title: 'Book',
          author: 'Author',
          isbn: '9780000000003',
          price: '10.00',
        }),
      });

      expect(res.status).toBe(403);
    });

    it('should return 400 for missing required fields', async () => {
      const admin = await createTestAdmin();
      const token = await generateTestToken(admin.id, 'admin');

      const res = await app.request('/books', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(token),
        },
        body: JSON.stringify({ title: 'Only Title' }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expectValidationError(body);
    });

    it('should return 409 for duplicate ISBN', async () => {
      const existingBook = await createTestBook();
      const admin = await createTestAdmin();
      const token = await generateTestToken(admin.id, 'admin');

      const res = await app.request('/books', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(token),
        },
        body: JSON.stringify({
          title: 'Another Book',
          author: 'Another Author',
          isbn: existingBook.isbn,
          price: '15.00',
        }),
      });

      expect(res.status).toBe(409);
    });
  });

  // --- UPDATE BOOK ---
  describe('PATCH /books/:id', () => {
    it('should update a book when authenticated as admin', async () => {
      const book = await createTestBook();
      const admin = await createTestAdmin();
      const token = await generateTestToken(admin.id, 'admin');

      const res = await app.request(`/books/${book.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(token),
        },
        body: JSON.stringify({ title: 'Updated Title' }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.title).toBe('Updated Title');
      expect(body.author).toBe(book.author);
    });

    it('should return 404 for non-existent book', async () => {
      const admin = await createTestAdmin();
      const token = await generateTestToken(admin.id, 'admin');

      const res = await app.request(
        '/books/00000000-0000-0000-0000-000000000000',
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...authHeader(token),
          },
          body: JSON.stringify({ title: 'Nope' }),
        },
      );

      expect(res.status).toBe(404);
    });

    it('should return 401 when not authenticated', async () => {
      const book = await createTestBook();

      const res = await app.request(`/books/${book.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Nope' }),
      });

      expect(res.status).toBe(401);
    });
  });

  // --- DELETE BOOK ---
  describe('DELETE /books/:id', () => {
    it('should delete a book when authenticated as admin', async () => {
      const book = await createTestBook();
      const admin = await createTestAdmin();
      const token = await generateTestToken(admin.id, 'admin');

      const res = await app.request(`/books/${book.id}`, {
        method: 'DELETE',
        headers: authHeader(token),
      });

      expect(res.status).toBe(204);

      // Verify it is gone
      const getRes = await app.request(`/books/${book.id}`);
      expect(getRes.status).toBe(404);
    });

    it('should return 404 for non-existent book', async () => {
      const admin = await createTestAdmin();
      const token = await generateTestToken(admin.id, 'admin');

      const res = await app.request(
        '/books/00000000-0000-0000-0000-000000000000',
        {
          method: 'DELETE',
          headers: authHeader(token),
        },
      );

      expect(res.status).toBe(404);
    });

    it('should return 401 when not authenticated', async () => {
      const book = await createTestBook();

      const res = await app.request(`/books/${book.id}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(401);
    });
  });
});
```

**Example: Auth Tests**

```typescript
// api/tests/routes/auth.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getTestApp } from '../helpers/app';
import { createTestUser } from '../helpers';

describe('Auth API', () => {
  let app: ReturnType<typeof getTestApp>;

  beforeEach(() => {
    app = getTestApp();
  });

  describe('POST /auth/register', () => {
    it('should register a new user', async () => {
      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'new@example.com',
          password: 'securepassword123',
          name: 'New User',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('user');
      expect(body.user.email).toBe('new@example.com');
      expect(body.user).not.toHaveProperty('passwordHash');
    });

    it('should return 409 for duplicate email', async () => {
      await createTestUser({ email: 'taken@example.com' });

      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'taken@example.com',
          password: 'securepassword123',
          name: 'Duplicate',
        }),
      });

      expect(res.status).toBe(409);
    });

    it('should reject weak passwords', async () => {
      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'weak@example.com',
          password: 'short',
          name: 'Weak',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/login', () => {
    it('should return a token for valid credentials', async () => {
      await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'login@example.com',
          password: 'securepassword123',
          name: 'Login User',
        }),
      });

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'login@example.com',
          password: 'securepassword123',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('refreshToken');
    });

    it('should return 401 for invalid password', async () => {
      await createTestUser({ email: 'bad@example.com' });

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'bad@example.com',
          password: 'wrongpassword',
        }),
      });

      expect(res.status).toBe(401);
    });

    it('should return 401 for non-existent email', async () => {
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'ghost@example.com',
          password: 'password123',
        }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/refresh', () => {
    it('should return a new token pair for valid refresh token', async () => {
      await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'refresh@example.com',
          password: 'securepassword123',
          name: 'Refresh User',
        }),
      });

      const loginRes = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'refresh@example.com',
          password: 'securepassword123',
        }),
      });
      const loginBody = await loginRes.json();

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('refreshToken');
    });

    it('should return 401 for invalid refresh token', async () => {
      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'invalid-token' }),
      });

      expect(res.status).toBe(401);
    });
  });
});
```

### Step 6 -- Generate Tests for Orders (Auth-Protected Resource)

```typescript
// api/tests/routes/orders.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getTestApp } from '../helpers/app';
import {
  createTestUser,
  createTestAdmin,
  createTestBook,
  createTestOrder,
  generateTestToken,
  authHeader,
  expectPaginatedResponse,
} from '../helpers';

describe('Orders API', () => {
  let app: ReturnType<typeof getTestApp>;

  beforeEach(() => {
    app = getTestApp();
  });

  describe('GET /orders', () => {
    it('should return orders for the authenticated user only', async () => {
      const user1 = await createTestUser({ email: 'user1@example.com' });
      const user2 = await createTestUser({ email: 'user2@example.com' });
      const book = await createTestBook();

      await createTestOrder(user1.id, [{ bookId: book.id, quantity: 1 }]);
      await createTestOrder(user2.id, [{ bookId: book.id, quantity: 2 }]);

      const token = await generateTestToken(user1.id);
      const res = await app.request('/orders', {
        headers: authHeader(token),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expectPaginatedResponse(body);
      expect(body.data).toHaveLength(1);
    });

    it('should return all orders for admin', async () => {
      const user = await createTestUser({ email: 'regular@example.com' });
      const admin = await createTestAdmin();
      const book = await createTestBook();

      await createTestOrder(user.id, [{ bookId: book.id, quantity: 1 }]);
      await createTestOrder(admin.id, [{ bookId: book.id, quantity: 2 }]);

      const token = await generateTestToken(admin.id, 'admin');
      const res = await app.request('/orders', {
        headers: authHeader(token),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(2);
    });

    it('should return 401 when not authenticated', async () => {
      const res = await app.request('/orders');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /orders', () => {
    it('should create an order with items', async () => {
      const user = await createTestUser();
      const book = await createTestBook({ stock: 10, price: '19.99' });
      const token = await generateTestToken(user.id);

      const res = await app.request('/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(token),
        },
        body: JSON.stringify({
          items: [{ bookId: book.id, quantity: 2 }],
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body).toHaveProperty('id');
      expect(body.status).toBe('pending');
      expect(body.total).toBe('39.98');
    });

    it('should reject order when book is out of stock', async () => {
      const user = await createTestUser();
      const book = await createTestBook({ stock: 0 });
      const token = await generateTestToken(user.id);

      const res = await app.request('/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(token),
        },
        body: JSON.stringify({
          items: [{ bookId: book.id, quantity: 1 }],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should reject order with empty items', async () => {
      const user = await createTestUser();
      const token = await generateTestToken(user.id);

      const res = await app.request('/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(token),
        },
        body: JSON.stringify({ items: [] }),
      });

      expect(res.status).toBe(400);
    });
  });
});
```

### Step 7 -- Add Response Schema Snapshot Tests

Status codes and `expectPaginatedResponse` catch broad shape changes, but they
do **not** catch "the `email` field was renamed to `emailAddress`" or "the
`address` object lost its `country` key." Those are breaking changes for every
client. Add a focused snapshot suite per resource that captures:

1. **Response body keys** -- with `toMatchInlineSnapshot()` for visibility in
   the test file itself. Derive the expected keys from the OpenAPI spec /
   Drizzle schema when generating the test so the inline value is correct from
   day one (the test then fails in RED until the handler matches, and acts as
   a regression check in GREEN).
2. **Full normalized response body** -- with `toMatchSnapshot()` to a sibling
   `__snapshots__` directory. Pass the body through `normalizeForSnapshot()`
   so UUIDs and timestamps collapse to placeholders.
3. **Response headers** -- `Content-Type`, `Cache-Control`, and any custom
   headers (rate-limit, deprecation, request-id) the API contract promises.
4. **Error response shapes** -- the validation, not-found, unauthorized, and
   forbidden envelopes. Consumers branch on these too.

**Example: Books snapshot file**

```typescript
// api/tests/routes/books.snapshot.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getTestApp } from '../helpers/app';
import {
  createTestAdmin,
  createTestBook,
  generateTestToken,
  authHeader,
  normalizeForSnapshot,
  responseShape,
  snapshotHeaders,
} from '../helpers';

describe('Books API -- response schema snapshots', () => {
  let app: ReturnType<typeof getTestApp>;

  beforeEach(() => {
    app = getTestApp();
  });

  it('GET /books/:id response body keys match the contract', async () => {
    const book = await createTestBook();

    const res = await app.request(`/books/${book.id}`);
    const body = await res.json();

    expect(responseShape(body)).toMatchInlineSnapshot(`
      [
        "author",
        "createdAt",
        "id",
        "isbn",
        "price",
        "stock",
        "title",
        "updatedAt",
      ]
    `);
  });

  it('GET /books/:id full response matches snapshot', async () => {
    const book = await createTestBook({
      title: 'Snapshot Book',
      author: 'Snapshot Author',
      isbn: '9780000000099',
      price: '19.99',
      stock: 7,
    });

    const res = await app.request(`/books/${book.id}`);
    const body = await res.json();

    expect(normalizeForSnapshot(body)).toMatchSnapshot();
  });

  it('GET /books response headers match contract', async () => {
    const res = await app.request('/books');

    expect(snapshotHeaders(res)).toMatchInlineSnapshot(`
      {
        "cache-control": null,
        "content-type": "application/json; charset=UTF-8",
        "vary": null,
      }
    `);
  });

  it('GET /books paginated envelope matches snapshot', async () => {
    await createTestBook({ title: 'A', isbn: '9780000001001' });
    await createTestBook({ title: 'B', isbn: '9780000001002' });

    const res = await app.request('/books?page=1&limit=10');
    const body = await res.json();

    expect(responseShape(body)).toMatchInlineSnapshot(`
      [
        "data",
        "meta",
      ]
    `);
    expect(responseShape(body.meta)).toMatchInlineSnapshot(`
      [
        "limit",
        "page",
        "total",
        "totalPages",
      ]
    `);
  });

  // --- Error shapes ---

  it('400 validation error shape', async () => {
    const admin = await createTestAdmin();
    const token = await generateTestToken(admin.id, 'admin');

    const res = await app.request('/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ title: 'Only Title' }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(responseShape(body.error)).toMatchInlineSnapshot(`
      [
        "code",
        "details",
        "message",
      ]
    `);
    expect(body.error.code).toMatchInlineSnapshot('"VALIDATION_ERROR"');
  });

  it('404 not-found error shape', async () => {
    const res = await app.request('/books/00000000-0000-0000-0000-000000000000');
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(normalizeForSnapshot(body)).toMatchInlineSnapshot(`
      {
        "error": {
          "code": "NOT_FOUND",
          "message": "Book not found",
        },
      }
    `);
  });

  it('401 unauthorized error shape', async () => {
    const res = await app.request('/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(responseShape(body.error)).toMatchInlineSnapshot(`
      [
        "code",
        "message",
      ]
    `);
  });
});
```

**Generation rules** (the route-generation step relies on these):

- One `*.snapshot.test.ts` file per resource, alongside the CRUD test file.
- Inline snapshots (`toMatchInlineSnapshot`) for: top-level key lists, error
  envelope keys, error `code` literals, and the headers object. These are the
  **contract-critical** fields -- breakage shows up in the test file itself in
  code review.
- File snapshots (`toMatchSnapshot`) for: full normalized response bodies and
  any deeply-nested shapes. Stored under `tests/routes/__snapshots__/`.
- Always pass response bodies through `normalizeForSnapshot()` before
  `toMatchSnapshot()` so UUIDs and ISO timestamps do not cause spurious diffs.

**Updating snapshots when a change is intentional**

A failing snapshot test means one of two things:

1. **Regression** -- the handler stopped returning a field the contract
   promised. Fix the handler.
2. **Intentional contract change** -- the OpenAPI spec was deliberately
   updated. After verifying the change is correct *and* documented in the
   spec, regenerate snapshots:

   ```bash
   cd api && pnpm vitest run -u                        # update all snapshots
   cd api && pnpm vitest run tests/routes/books -u     # update one resource
   ```

   Commit the snapshot diff (`__snapshots__/*.snap` files and any inline
   snapshot changes) as part of the same PR that changes the response shape,
   and call it out in the PR description so reviewers explicitly acknowledge
   the consumer-visible change.

> Snapshot tests fail in RED for the same reason every other test in this
> phase fails -- there is no handler yet. File snapshots will be created on
> the first GREEN run; inline snapshots derived from the spec already encode
> the expected shape and will start passing as soon as the handler matches.

### Step 8 -- Confirm RED Phase (Hard Gate)

Run the tests and confirm they all fail:

```bash
cd api && pnpm vitest run --reporter=verbose 2>&1
```

**Expected output:** All tests should FAIL because no route handlers exist yet.

```
FAIL  tests/routes/books.test.ts
FAIL  tests/routes/auth.test.ts
FAIL  tests/routes/orders.test.ts

Test Files  3 failed (3)
Tests       X failed (X)
```

**HARD GATE CHECK:**

```bash
# Verify all tests are failing (not erroring due to bad setup)
cd api && pnpm vitest run --reporter=json 2>&1 | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const report = JSON.parse(chunks.join(''));
    const allFailing = report.testResults.every(f => f.status === 'failed');
    if (!allFailing) {
      console.error('RED PHASE GATE FAILED: Some tests are passing!');
      process.exit(1);
    }
    console.log('RED PHASE GATE PASSED');
    console.log('Total test files:', report.numTotalTestSuites);
    console.log('Total tests:', report.numTotalTests);
  });
"
```

## Output

| Artifact | Location | Description |
|---|---|---|
| Test config | `api/vitest.config.ts` | Vitest configuration |
| Test setup | `api/tests/setup.ts` | Database container and cleanup |
| Test helpers | `api/tests/helpers/index.ts` | Factories, auth helpers, assertions, snapshot normalizers |
| App helper | `api/tests/helpers/app.ts` | Test app instantiation |
| Route tests | `api/tests/routes/*.test.ts` | One test file per resource |
| Schema snapshot tests | `api/tests/routes/*.snapshot.test.ts` | Response body keys, normalized bodies, headers, and error envelopes |
| Snapshot store | `api/tests/routes/__snapshots__/*.snap` | Generated on first GREEN run; committed to the repo as the contract record |

## Integration

| Skill | Relationship |
|---|---|
| `database-design` (Phase 1) | Tests import Drizzle schemas for factory functions |
| `route-generation` (Phase 3) | Implements handlers that make these tests GREEN |
| `api-testing-verification` (Phase 4) | Extends these tests with contract and load tests |
| `api-authentication` | Auth test patterns used across all protected routes |
| `api-validation` | Validation error assertions match the Zod middleware format |

### Hard Gate Rule

Phase 3 (route-generation) MUST NOT begin until:
1. All test files exist for every endpoint in build-spec.json.
2. `pnpm vitest run` executes without configuration errors.
3. All tests are confirmed RED (failing due to missing implementations, not broken test setup).

If tests fail due to setup issues (import errors, missing files), fix the test
infrastructure first. Only proceed when failures are purely "route not found" or
"function not implemented" errors.
