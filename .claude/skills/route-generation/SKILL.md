---
name: route-generation
description: >
  Generates Hono route handlers, service layer, and middleware that make the failing
  tests from Phase 2 pass. Reads build-spec.json for the endpoint inventory, creates
  route files with proper typing, implements business logic in a service layer, wires
  up Drizzle queries, and adds Zod validation middleware. Tests are run after each
  route group to confirm GREEN. Keywords: hono, route, handler, controller, service,
  middleware, endpoint, api, rest, crud, green-phase, implementation, drizzle-query
---

# Route Generation (Phase 3)

## Purpose

Implements Hono route handlers and a service layer that satisfy all tests written
in Phase 2. Routes are generated group-by-group (one resource at a time), with
tests run after each group to incrementally turn RED tests GREEN. The service
layer encapsulates database queries and business logic, keeping route handlers thin.

## When to Use

- Phase 2 (tdd-from-schema) is complete and all tests are confirmed RED.
- The user says "generate routes", "implement endpoints", "green phase", or "make tests pass".
- A new resource has been added and needs route handlers.

## Inputs

| Input | Required | Description |
|---|---|---|
| `build-spec.json` | Yes | `.claude/plans/build-spec.json` with endpoint definitions |
| Failing tests | Yes | `api/tests/routes/*.test.ts` from Phase 2 |
| Drizzle schemas | Yes | `api/src/db/schema/*.ts` from Phase 1 |
| Zod validators | Yes | `api/src/validators/*.ts` from Phase 1 |

## Steps

### Step 1 -- Create the App Factory

The Hono app must accept dependencies (database, config) for testability:

```typescript
// api/src/app.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { secureHeaders } from 'hono/secure-headers';
import type { Database } from './db';
import { booksRoutes } from './routes/books';
import { authRoutes } from './routes/auth';
import { ordersRoutes } from './routes/orders';
import { usersRoutes } from './routes/users';
import { errorHandler } from './middleware/error-handler';

export type AppEnv = {
  Variables: {
    db: Database;
    userId: string;
    userRole: string;
  };
};

export function createApp({ db }: { db: Database }) {
  const app = new Hono<AppEnv>();

  // Global middleware
  app.use('*', logger());
  app.use('*', prettyJSON());
  app.use('*', secureHeaders());
  app.use('*', cors({
    origin: ['http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }));

  // Inject database into context
  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });

  // Error handler
  app.onError(errorHandler);

  // Routes
  app.route('/auth', authRoutes());
  app.route('/books', booksRoutes());
  app.route('/orders', ordersRoutes());
  app.route('/users', usersRoutes());

  // Health check
  app.get('/health', (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString() }),
  );

  // 404 handler
  app.notFound((c) => {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Route not found' } },
      404,
    );
  });

  return app;
}
```

### Step 2 -- Create Error Handling Middleware

```typescript
// api/src/middleware/error-handler.ts
import type { ErrorHandler } from 'hono';
import type { AppEnv } from '../app';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(
      404,
      'NOT_FOUND',
      id ? `${resource} with ID ${id} not found` : `${resource} not found`,
    );
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(403, 'FORBIDDEN', message);
  }
}

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  // Zod validation errors
  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: err.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
            code: e.code,
          })),
        },
      },
      400,
    );
  }

  // Application errors
  if (err instanceof AppError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      },
      err.statusCode as any,
    );
  }

  // Unexpected errors
  console.error('Unhandled error:', err);
  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    },
    500,
  );
};
```

### Step 3 -- Create Auth Middleware

```typescript
// api/src/middleware/auth.ts
import { createMiddleware } from 'hono/factory';
import { jwtVerify } from 'jose';
import type { AppEnv } from '../app';
import { UnauthorizedError, ForbiddenError } from './error-handler';

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'test-secret-key-at-least-32-chars!!',
);

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError();
  }

  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    c.set('userId', payload.sub as string);
    c.set('userRole', (payload.role as string) ?? 'customer');
    await next();
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
});

export const requireRole = (...roles: string[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const userRole = c.get('userRole');
    if (!roles.includes(userRole)) {
      throw new ForbiddenError();
    }
    await next();
  });
```

### Step 4 -- Create the Service Layer

One service per resource, encapsulating all database operations:

```typescript
// api/src/services/books.service.ts
import { eq, sql, ilike, asc, desc } from 'drizzle-orm';
import { books } from '../db/schema';
import type { Database } from '../db';
import type { InsertBook, UpdateBook, ListBooksQuery } from '../validators/books';
import { NotFoundError, ConflictError } from '../middleware/error-handler';

export class BooksService {
  constructor(private db: Database) {}

  async list(query: ListBooksQuery) {
    const { page, limit, search, author, sortBy, sortOrder } = query;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (search) {
      conditions.push(ilike(books.title, `%${search}%`));
    }
    if (author) {
      conditions.push(ilike(books.author, `%${author}%`));
    }

    const whereClause = conditions.length
      ? sql`${sql.join(conditions, sql` AND `)}`
      : undefined;

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(books)
      .where(whereClause);

    const orderFn = sortOrder === 'asc' ? asc : desc;
    const orderColumn = books[sortBy as keyof typeof books] ?? books.createdAt;

    const data = await this.db
      .select()
      .from(books)
      .where(whereClause)
      .orderBy(orderFn(orderColumn as any))
      .limit(limit)
      .offset(offset);

    return {
      data,
      meta: {
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit),
      },
    };
  }

  async getById(id: string) {
    const book = await this.db.query.books.findFirst({
      where: eq(books.id, id),
    });
    if (!book) throw new NotFoundError('Book', id);
    return book;
  }

  async create(data: InsertBook) {
    const existing = await this.db.query.books.findFirst({
      where: eq(books.isbn, data.isbn),
    });
    if (existing) {
      throw new ConflictError(`Book with ISBN ${data.isbn} already exists`);
    }

    const [book] = await this.db.insert(books).values(data).returning();
    return book;
  }

  async update(id: string, data: UpdateBook) {
    const existing = await this.db.query.books.findFirst({
      where: eq(books.id, id),
    });
    if (!existing) throw new NotFoundError('Book', id);

    const [updated] = await this.db
      .update(books)
      .set(data)
      .where(eq(books.id, id))
      .returning();
    return updated;
  }

  async delete(id: string) {
    const existing = await this.db.query.books.findFirst({
      where: eq(books.id, id),
    });
    if (!existing) throw new NotFoundError('Book', id);

    await this.db.delete(books).where(eq(books.id, id));
  }
}
```

### Step 5 -- Create Route Handlers

```typescript
// api/src/routes/books.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppEnv } from '../app';
import { BooksService } from '../services/books.service';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  insertBookSchema,
  updateBookSchema,
  listBooksQuerySchema,
} from '../validators/books';
import { uuidParamSchema } from '../validators';

export function booksRoutes() {
  const router = new Hono<AppEnv>();

  // GET /books -- public, paginated list
  router.get(
    '/',
    zValidator('query', listBooksQuerySchema),
    async (c) => {
      const query = c.req.valid('query');
      const service = new BooksService(c.get('db'));
      const result = await service.list(query);
      return c.json(result);
    },
  );

  // GET /books/:id -- public, single book
  router.get(
    '/:id',
    zValidator('param', uuidParamSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const service = new BooksService(c.get('db'));
      const book = await service.getById(id);
      return c.json(book);
    },
  );

  // POST /books -- admin only
  router.post(
    '/',
    requireAuth,
    requireRole('admin'),
    zValidator('json', insertBookSchema),
    async (c) => {
      const data = c.req.valid('json');
      const service = new BooksService(c.get('db'));
      const book = await service.create(data);
      return c.json(book, 201);
    },
  );

  // PATCH /books/:id -- admin only
  router.patch(
    '/:id',
    requireAuth,
    requireRole('admin'),
    zValidator('param', uuidParamSchema),
    zValidator('json', updateBookSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const data = c.req.valid('json');
      const service = new BooksService(c.get('db'));
      const book = await service.update(id, data);
      return c.json(book);
    },
  );

  // DELETE /books/:id -- admin only
  router.delete(
    '/:id',
    requireAuth,
    requireRole('admin'),
    zValidator('param', uuidParamSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const service = new BooksService(c.get('db'));
      await service.delete(id);
      return c.body(null, 204);
    },
  );

  return router;
}
```

**Auth Routes:**

```typescript
// api/src/routes/auth.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppEnv } from '../app';
import { AuthService } from '../services/auth.service';
import { registerUserSchema, loginSchema } from '../validators/users';
import { z } from 'zod';

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export function authRoutes() {
  const router = new Hono<AppEnv>();

  router.post(
    '/register',
    zValidator('json', registerUserSchema),
    async (c) => {
      const data = c.req.valid('json');
      const service = new AuthService(c.get('db'));
      const result = await service.register(data);
      return c.json(result, 201);
    },
  );

  router.post(
    '/login',
    zValidator('json', loginSchema),
    async (c) => {
      const data = c.req.valid('json');
      const service = new AuthService(c.get('db'));
      const result = await service.login(data.email, data.password);
      return c.json(result);
    },
  );

  router.post(
    '/refresh',
    zValidator('json', refreshSchema),
    async (c) => {
      const { refreshToken } = c.req.valid('json');
      const service = new AuthService(c.get('db'));
      const result = await service.refresh(refreshToken);
      return c.json(result);
    },
  );

  return router;
}
```

### Step 6 -- Auth Service Implementation

```typescript
// api/src/services/auth.service.ts
import { eq } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { users } from '../db/schema';
import type { Database } from '../db';
import { UnauthorizedError, ConflictError } from '../middleware/error-handler';

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'test-secret-key-at-least-32-chars!!',
);
const REFRESH_SECRET = new TextEncoder().encode(
  process.env.REFRESH_SECRET ?? 'refresh-secret-key-at-least-32-chars!!',
);

export class AuthService {
  constructor(private db: Database) {}

  async register(data: { email: string; password: string; name: string }) {
    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, data.email),
    });
    if (existing) throw new ConflictError('Email already registered');

    const passwordHash = await this.hashPassword(data.password);

    const [user] = await this.db
      .insert(users)
      .values({
        email: data.email,
        name: data.name,
        passwordHash,
        role: 'customer',
      })
      .returning();

    const token = await this.generateToken(user.id, user.role);
    const refreshToken = await this.generateRefreshToken(user.id);

    return {
      token,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }

  async login(email: string, password: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.email, email),
    });
    if (!user) throw new UnauthorizedError('Invalid credentials');

    const valid = await this.verifyPassword(password, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Invalid credentials');

    const token = await this.generateToken(user.id, user.role);
    const refreshToken = await this.generateRefreshToken(user.id);

    return { token, refreshToken };
  }

  async refresh(refreshToken: string) {
    try {
      const { payload } = await jwtVerify(refreshToken, REFRESH_SECRET);
      const userId = payload.sub as string;

      const user = await this.db.query.users.findFirst({
        where: eq(users.id, userId),
      });
      if (!user) throw new UnauthorizedError('Invalid refresh token');

      const newToken = await this.generateToken(user.id, user.role);
      const newRefreshToken = await this.generateRefreshToken(user.id);

      return { token: newToken, refreshToken: newRefreshToken };
    } catch {
      throw new UnauthorizedError('Invalid refresh token');
    }
  }

  private async generateToken(userId: string, role: string) {
    return new SignJWT({ sub: userId, role })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('15m')
      .setIssuedAt()
      .sign(JWT_SECRET);
  }

  private async generateRefreshToken(userId: string) {
    return new SignJWT({ sub: userId })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('7d')
      .setIssuedAt()
      .sign(REFRESH_SECRET);
  }

  private async hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Buffer.from(hashBuffer).toString('hex');
  }

  private async verifyPassword(password: string, hash: string): Promise<boolean> {
    const passwordHash = await this.hashPassword(password);
    return passwordHash === hash;
  }
}
```

### Step 7 -- Run Tests Incrementally

After implementing each resource group, run the corresponding tests:

```bash
# After implementing books routes
cd api && pnpm vitest run tests/routes/books.test.ts --reporter=verbose

# After implementing auth routes
cd api && pnpm vitest run tests/routes/auth.test.ts --reporter=verbose

# After implementing orders routes
cd api && pnpm vitest run tests/routes/orders.test.ts --reporter=verbose

# Final: run all tests
cd api && pnpm vitest run --reporter=verbose --coverage
```

All tests must pass and coverage thresholds defined in vitest.config.ts must be met.

## Output

| Artifact | Location | Description |
|---|---|---|
| App factory | `api/src/app.ts` | Hono app with DI and middleware |
| Error handling | `api/src/middleware/error-handler.ts` | Centralised error handling |
| Auth middleware | `api/src/middleware/auth.ts` | JWT verification and RBAC |
| Route files | `api/src/routes/*.ts` | One file per resource |
| Service files | `api/src/services/*.ts` | Business logic per resource |

## Integration

| Skill | Relationship |
|---|---|
| `tdd-from-schema` (Phase 2) | Tests that this phase must make pass |
| `api-testing-verification` (Phase 4) | Extends testing with contract and load tests |
| `api-authentication` | Detailed auth patterns beyond basic JWT |
| `api-validation` | Advanced validation middleware patterns |
| `database-design` | Drizzle schemas used in service layer queries |
| `deployment-config-generator` | Entry point wiring depends on deployment target |

### Implementation Order

1. Error handling middleware (used by everything).
2. Auth middleware (used by protected routes).
3. Auth routes and service (login/register needed by all auth tests).
4. Public resource routes (e.g., books GET endpoints).
5. Protected resource routes (e.g., books POST/PATCH/DELETE).
6. Relationship-dependent routes (e.g., orders referencing users and books).
7. Run full test suite and confirm GREEN.
