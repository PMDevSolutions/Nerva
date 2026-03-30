---
name: api-authentication
description: >
  Implements JWT, OAuth2, API key, and RBAC authentication patterns for Hono APIs.
  Generates auth middleware, token endpoints (login, refresh, revoke), role-based
  access control, and integrates with the Drizzle user schema. Uses the jose library
  for JWT operations. Keywords: jwt, oauth2, api-key, rbac, auth, authentication,
  authorization, middleware, token, login, register, refresh, revoke, bearer,
  session, permission, role, guard, jose, password, bcrypt, argon2
---

# API Authentication

## Purpose

Implements authentication and authorization for Hono APIs. Supports JWT bearer
tokens, API key authentication, OAuth2 flows, and role-based access control (RBAC).
Generates all necessary middleware, token management endpoints, and integrates
with the Drizzle ORM user schema.

## When to Use

- Setting up authentication for a new API.
- Adding auth middleware to route groups.
- Implementing login, registration, token refresh, or token revocation.
- Configuring RBAC with roles and permissions.
- The user says "add auth", "jwt", "login endpoint", "protect route", or "rbac".

## Inputs

| Input | Required | Description |
|---|---|---|
| `build-spec.json` | Yes | Auth strategy from `.claude/plans/build-spec.json` |
| User schema | Yes | `api/src/db/schema/users.ts` from Phase 1 |

## Steps

### Step 1 -- Determine Auth Strategy

Read the auth strategy from build-spec.json and configure accordingly:

```typescript
// Supported strategies
type AuthStrategy = 'jwt' | 'apikey' | 'oauth2' | 'none';

const strategy = spec.auth.strategy;
```

### Step 2 -- JWT Authentication (Default)

**Install dependencies:**

```bash
cd api && pnpm add jose
cd api && pnpm add -D @types/bcryptjs
# For Node.js: pnpm add bcryptjs
# For Cloudflare Workers: use @noble/hashes or Web Crypto API
```

**JWT Middleware:**

```typescript
// api/src/middleware/auth.ts
import { createMiddleware } from 'hono/factory';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { AppEnv } from '../app';

export interface TokenPayload extends JWTPayload {
  sub: string;
  role: string;
  email: string;
}

function getSecret(env?: any): Uint8Array {
  const secret = env?.JWT_SECRET ?? process.env.JWT_SECRET ?? '';
  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  return new TextEncoder().encode(secret);
}

function getRefreshSecret(env?: any): Uint8Array {
  const secret = env?.REFRESH_SECRET ?? process.env.REFRESH_SECRET ?? '';
  return new TextEncoder().encode(secret);
}

// Verify JWT and inject user context
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Missing bearer token' } },
      401,
    );
  }

  const token = authHeader.slice(7);
  try {
    const secret = getSecret(c.env);
    const { payload } = await jwtVerify(token, secret);
    c.set('userId', payload.sub as string);
    c.set('userRole', (payload.role as string) ?? 'customer');
    await next();
  } catch (err) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } },
      401,
    );
  }
});

// Optional auth -- sets user context if token present, continues if not
export const optionalAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const secret = getSecret(c.env);
      const { payload } = await jwtVerify(token, secret);
      c.set('userId', payload.sub as string);
      c.set('userRole', (payload.role as string) ?? 'customer');
    } catch {
      // Token invalid but auth is optional -- continue without user context
    }
  }
  await next();
});

// Role-based access control
export const requireRole = (...roles: string[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const userRole = c.get('userRole');
    if (!userRole || !roles.includes(userRole)) {
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
        403,
      );
    }
    await next();
  });

// Token generation utilities
export async function generateAccessToken(
  payload: { sub: string; role: string; email: string },
  secret: Uint8Array,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

export async function generateRefreshToken(
  userId: string,
  secret: Uint8Array,
): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
}
```

**Token Endpoints:**

```typescript
// api/src/routes/auth.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { users } from '../db/schema';
import {
  generateAccessToken,
  generateRefreshToken,
  requireAuth,
} from '../middleware/auth';
import { registerUserSchema, loginSchema } from '../validators/users';

export function authRoutes() {
  const router = new Hono<AppEnv>();

  // POST /auth/register
  router.post(
    '/register',
    zValidator('json', registerUserSchema),
    async (c) => {
      const { email, password, name } = c.req.valid('json');
      const db = c.get('db');

      // Check duplicate email
      const existing = await db.query.users.findFirst({
        where: eq(users.email, email),
      });
      if (existing) {
        return c.json(
          { error: { code: 'CONFLICT', message: 'Email already registered' } },
          409,
        );
      }

      // Hash password
      const passwordHash = await hashPassword(password);

      // Create user
      const [user] = await db
        .insert(users)
        .values({ email, passwordHash, name, role: 'customer' })
        .returning();

      // Generate tokens
      const secret = getSecret(c.env);
      const refreshSecret = getRefreshSecret(c.env);
      const token = await generateAccessToken(
        { sub: user.id, role: user.role, email: user.email },
        secret,
      );
      const refreshToken = await generateRefreshToken(user.id, refreshSecret);

      return c.json(
        {
          token,
          refreshToken,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
          },
        },
        201,
      );
    },
  );

  // POST /auth/login
  router.post(
    '/login',
    zValidator('json', loginSchema),
    async (c) => {
      const { email, password } = c.req.valid('json');
      const db = c.get('db');

      const user = await db.query.users.findFirst({
        where: eq(users.email, email),
      });
      if (!user) {
        return c.json(
          { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } },
          401,
        );
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        return c.json(
          { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } },
          401,
        );
      }

      const secret = getSecret(c.env);
      const refreshSecret = getRefreshSecret(c.env);
      const token = await generateAccessToken(
        { sub: user.id, role: user.role, email: user.email },
        secret,
      );
      const refreshToken = await generateRefreshToken(user.id, refreshSecret);

      return c.json({ token, refreshToken });
    },
  );

  // POST /auth/refresh
  router.post(
    '/refresh',
    zValidator('json', z.object({ refreshToken: z.string().min(1) })),
    async (c) => {
      const { refreshToken } = c.req.valid('json');
      const db = c.get('db');

      try {
        const refreshSecret = getRefreshSecret(c.env);
        const { payload } = await jwtVerify(refreshToken, refreshSecret);
        const userId = payload.sub as string;

        const user = await db.query.users.findFirst({
          where: eq(users.id, userId),
        });
        if (!user) {
          return c.json(
            { error: { code: 'UNAUTHORIZED', message: 'Invalid token' } },
            401,
          );
        }

        const secret = getSecret(c.env);
        const newToken = await generateAccessToken(
          { sub: user.id, role: user.role, email: user.email },
          secret,
        );
        const newRefreshToken = await generateRefreshToken(user.id, refreshSecret);

        return c.json({ token: newToken, refreshToken: newRefreshToken });
      } catch {
        return c.json(
          { error: { code: 'UNAUTHORIZED', message: 'Invalid refresh token' } },
          401,
        );
      }
    },
  );

  // GET /auth/me -- returns current user
  router.get('/me', requireAuth, async (c) => {
    const db = c.get('db');
    const userId = c.get('userId');

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!user) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'User not found' } },
        404,
      );
    }

    return c.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });
  });

  return router;
}
```

### Step 3 -- API Key Authentication (Alternative)

```typescript
// api/src/middleware/api-key-auth.ts
import { createMiddleware } from 'hono/factory';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../app';
import { apiKeys } from '../db/schema';

export const requireApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const apiKey = c.req.header('X-API-Key');
  if (!apiKey) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Missing API key' } },
      401,
    );
  }

  const db = c.get('db');

  // Hash the incoming key and look it up
  const keyHash = await hashApiKey(apiKey);
  const record = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, keyHash),
  });

  if (!record || record.revokedAt) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } },
      401,
    );
  }

  // Update last used timestamp
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, record.id));

  c.set('userId', record.userId);
  c.set('userRole', record.scope ?? 'customer');
  await next();
});

async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Buffer.from(hashBuffer).toString('hex');
}
```

### Step 4 -- Password Hashing

```typescript
// api/src/lib/password.ts

// For Node.js runtime:
import bcrypt from 'bcryptjs';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// For Cloudflare Workers (no bcrypt):
// Use Web Crypto API with PBKDF2
export async function hashPasswordWorkers(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  );
  const hashArray = new Uint8Array(derivedBits);
  const saltHex = Array.from(salt)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const hashHex = Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${saltHex}:${hashHex}`;
}
```

### Step 5 -- RBAC Permission System

```typescript
// api/src/middleware/rbac.ts
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app';

// Define permissions per role
const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['*'],
  manager: [
    'books:read',
    'books:create',
    'books:update',
    'orders:read',
    'orders:update',
    'users:read',
  ],
  customer: [
    'books:read',
    'orders:read',
    'orders:create',
    'users:read:own',
  ],
};

export function hasPermission(role: string, permission: string): boolean {
  const permissions = ROLE_PERMISSIONS[role] ?? [];
  if (permissions.includes('*')) return true;
  return permissions.includes(permission);
}

export const requirePermission = (permission: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const userRole = c.get('userRole');
    if (!hasPermission(userRole, permission)) {
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
        403,
      );
    }
    await next();
  });

// Usage in routes:
// router.post('/books', requireAuth, requirePermission('books:create'), handler);
// router.delete('/books/:id', requireAuth, requirePermission('books:delete'), handler);
```

## Output

| Artifact | Location | Description |
|---|---|---|
| Auth middleware | `api/src/middleware/auth.ts` | JWT verification and token generation |
| API key middleware | `api/src/middleware/api-key-auth.ts` | API key validation |
| RBAC middleware | `api/src/middleware/rbac.ts` | Permission-based access control |
| Auth routes | `api/src/routes/auth.ts` | Login, register, refresh, me |
| Password utils | `api/src/lib/password.ts` | Hashing and verification |

## Integration

| Skill | Relationship |
|---|---|
| `database-design` | User schema and API key schema |
| `route-generation` | Auth middleware applied to protected routes |
| `api-validation` | Zod schemas for login/register payloads |
| `api-security` | Rate limiting on auth endpoints, brute force protection |
| `tdd-from-schema` | Auth test helpers and token generation for tests |
