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

### Step 7 -- Confirm RED Phase (Hard Gate)

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
| Test helpers | `api/tests/helpers/index.ts` | Factories, auth helpers, assertions |
| App helper | `api/tests/helpers/app.ts` | Test app instantiation |
| Route tests | `api/tests/routes/*.test.ts` | One test file per resource |

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
