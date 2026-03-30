---
name: api-security
description: >
  Implements API security hardening including input sanitization, injection prevention,
  rate limiting, CORS configuration, security headers, request size limits, and IP
  blocking. Audits for common vulnerabilities and provides Hono middleware for each
  security layer. Keywords: security, rate-limit, cors, headers, csp, hsts, xss,
  injection, sanitize, csrf, brute-force, ip-block, request-limit, helmet, audit,
  vulnerability, owasp
---

# API Security

## Purpose

Hardens the API against common attack vectors by implementing security middleware,
input sanitization, rate limiting, proper CORS configuration, security headers,
and request size limits. Follows OWASP API Security Top 10 guidelines.

## When to Use

- Setting up security for a new API.
- Conducting a security audit before deployment.
- The user says "security", "rate limit", "cors", "headers", "xss", or "injection".
- Preparing for production deployment.

## Inputs

| Input | Required | Description |
|---|---|---|
| Hono app | Yes | `api/src/app.ts` |
| Route definitions | Yes | `api/src/routes/*.ts` |
| Deployment target | Recommended | From build-spec.json |

## Steps

### Step 1 -- Security Audit Checklist

Before implementing fixes, audit the codebase for common vulnerabilities:

| Category | Check | Risk |
|---|---|---|
| SQL Injection | Raw SQL queries with user input | Critical |
| XSS | User input reflected in responses without sanitization | High |
| Auth Bypass | Missing auth middleware on protected routes | Critical |
| Rate Limiting | No rate limiting on auth endpoints | High |
| CORS | Overly permissive CORS configuration | Medium |
| Headers | Missing security headers | Medium |
| Input Size | No request body size limits | Medium |
| Secrets | Hardcoded secrets or weak JWT keys | Critical |
| Error Leakage | Stack traces or internal details in error responses | Medium |
| Dependency | Known vulnerabilities in dependencies | Variable |

### Step 2 -- Rate Limiting Middleware

```typescript
// api/src/middleware/rate-limit.ts
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyGenerator?: (c: any) => string;
  message?: string;
}

// In-memory rate limiter (for Node.js)
const stores = new Map<
  string,
  Map<string, { count: number; resetAt: number }>
>();

export function rateLimit(options: RateLimitOptions) {
  const {
    windowMs,
    max,
    keyGenerator = (c) =>
      c.req.header('cf-connecting-ip') ??
      c.req.header('x-forwarded-for')?.split(',')[0] ??
      'unknown',
    message = 'Too many requests, please try again later',
  } = options;

  const storeKey = `${windowMs}:${max}`;
  if (!stores.has(storeKey)) {
    stores.set(storeKey, new Map());
  }
  const store = stores.get(storeKey)!;

  // Clean expired entries periodically
  setInterval(
    () => {
      const now = Date.now();
      for (const [key, entry] of store) {
        if (entry.resetAt <= now) {
          store.delete(key);
        }
      }
    },
    Math.min(windowMs, 60000),
  );

  return createMiddleware<AppEnv>(async (c, next) => {
    const key = keyGenerator(c);
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers
    c.header('X-RateLimit-Limit', String(max));
    c.header(
      'X-RateLimit-Remaining',
      String(Math.max(0, max - entry.count)),
    );
    c.header(
      'X-RateLimit-Reset',
      String(Math.ceil(entry.resetAt / 1000)),
    );

    if (entry.count > max) {
      c.header(
        'Retry-After',
        String(Math.ceil((entry.resetAt - now) / 1000)),
      );
      return c.json(
        { error: { code: 'RATE_LIMITED', message } },
        429,
      );
    }

    await next();
  });
}
```

Apply rate limiting to routes:

```typescript
// api/src/app.ts
import { rateLimit } from './middleware/rate-limit';

// Global rate limit: 100 requests per minute
app.use('*', rateLimit({ windowMs: 60 * 1000, max: 100 }));

// Stricter rate limit on auth endpoints
app.use(
  '/auth/*',
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: 'Too many authentication attempts',
  }),
);

// Very strict on password reset
app.use(
  '/auth/reset-password',
  rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3,
    message: 'Too many password reset attempts',
  }),
);
```

For Cloudflare Workers, use the built-in Rate Limiting API:

```toml
# In wrangler.toml
[[unsafe.bindings]]
name = "RATE_LIMITER"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 100, period = 60 }
```

### Step 3 -- CORS Configuration

```typescript
// api/src/middleware/cors-config.ts
import { cors } from 'hono/cors';

// Development CORS -- permissive
export const devCors = cors({
  origin: ['http://localhost:3000', 'http://localhost:5173'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  exposeHeaders: [
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'X-Request-ID',
  ],
  maxAge: 86400,
  credentials: true,
});

// Production CORS -- restrictive
export const prodCors = cors({
  origin: (origin, c) => {
    const allowedOrigins = [
      'https://myapp.example.com',
      'https://admin.example.com',
    ];
    if (allowedOrigins.includes(origin)) {
      return origin;
    }
    return null; // Reject unknown origins
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  maxAge: 86400,
  credentials: true,
});

// Usage
const isProduction = process.env.NODE_ENV === 'production';
app.use('*', isProduction ? prodCors : devCors);
```

**CORS rules:**
- Never use `origin: '*'` with `credentials: true`.
- Allowlist specific origins in production.
- Expose rate limit headers for client awareness.
- Set appropriate maxAge to reduce preflight requests.

### Step 4 -- Security Headers

```typescript
// api/src/middleware/security-headers.ts
import { secureHeaders } from 'hono/secure-headers';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app';

// Use Hono built-in secure headers
export const defaultSecurityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"], // For Scalar UI
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
  },
  strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
  xContentTypeOptions: 'nosniff',
  xFrameOptions: 'DENY',
  referrerPolicy: 'strict-origin-when-cross-origin',
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
  },
});

// Custom headers for API responses
export const apiSecurityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();

  // Remove headers that leak server info
  c.res.headers.delete('X-Powered-By');
  c.res.headers.delete('Server');

  // Add request ID for tracing
  const requestId =
    c.req.header('X-Request-ID') ?? crypto.randomUUID();
  c.header('X-Request-ID', requestId);

  // Cache control for API responses
  if (c.req.method === 'GET') {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
});
```

### Step 5 -- Request Size Limits

```typescript
// api/src/app.ts
import { bodyLimit } from 'hono/body-limit';

// Global body size limit: 1MB
app.use(
  '*',
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => {
      return c.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Request body exceeds the 1MB limit',
          },
        },
        413,
      );
    },
  }),
);

// Smaller limit for auth endpoints
app.use('/auth/*', bodyLimit({ maxSize: 10 * 1024 })); // 10KB
```

### Step 6 -- SQL Injection Prevention

Drizzle ORM prevents SQL injection by default through parameterized queries.
Audit for unsafe patterns:

```typescript
// BAD: Raw SQL with string interpolation -- SQL INJECTION RISK
const results = await db.execute(
  sql.raw(`SELECT * FROM users WHERE email = '${userInput}'`),
);

// GOOD: Parameterized query via Drizzle
const results = await db.query.users.findFirst({
  where: eq(users.email, userInput),
});

// GOOD: If raw SQL is needed, use the sql template tag
const results = await db.execute(
  sql`SELECT * FROM users WHERE email = ${userInput}`,
);

// GOOD: Dynamic column names validated against allowlist
const ALLOWED_SORT_COLUMNS = [
  'title',
  'author',
  'price',
  'createdAt',
] as const;
type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

function getSortColumn(input: string): SortColumn {
  if (
    !ALLOWED_SORT_COLUMNS.includes(input as SortColumn)
  ) {
    throw new Error('Invalid sort column');
  }
  return input as SortColumn;
}

// GOOD: Escape LIKE wildcards in search input
function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, '\\$&');
}

const searchTerm = escapeLikePattern(userInput);
const results = await db
  .select()
  .from(books)
  .where(ilike(books.title, `%${searchTerm}%`));
```

### Step 7 -- Input Sanitization

```typescript
// api/src/lib/sanitize.ts

// Sanitize string inputs to prevent stored XSS
export function sanitizeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Deep sanitize an object's string values
export function sanitizeObject<T extends Record<string, unknown>>(
  obj: T,
): T {
  const sanitized = { ...obj };
  for (const [key, value] of Object.entries(sanitized)) {
    if (typeof value === 'string') {
      (sanitized as any)[key] = sanitizeHtml(value);
    } else if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      (sanitized as any)[key] = sanitizeObject(
        value as Record<string, unknown>,
      );
    }
  }
  return sanitized;
}
```

### Step 8 -- IP Blocking

```typescript
// api/src/middleware/ip-block.ts
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app';

const BLOCKED_IPS = new Set<string>();

export function loadBlockedIPs(ips: string[]) {
  for (const ip of ips) {
    BLOCKED_IPS.add(ip);
  }
}

export const ipBlocker = createMiddleware<AppEnv>(async (c, next) => {
  const ip =
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown';

  if (BLOCKED_IPS.has(ip)) {
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'Access denied' } },
      403,
    );
  }

  await next();
});
```

### Step 9 -- Dependency Audit

```bash
# Check for known vulnerabilities
cd api && pnpm audit

# Auto-fix where possible
cd api && pnpm audit --fix

# Check for outdated packages
cd api && pnpm outdated
```

### Step 10 -- Full Security Middleware Stack

Wire everything together in the correct order:

```typescript
// api/src/app.ts
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { rateLimit } from './middleware/rate-limit';
import {
  defaultSecurityHeaders,
  apiSecurityHeaders,
} from './middleware/security-headers';
import { ipBlocker } from './middleware/ip-block';
import { prodCors, devCors } from './middleware/cors-config';
import { errorHandler } from './middleware/error-handler';

const isProduction = process.env.NODE_ENV === 'production';

export function createApp({ db }: { db: Database }) {
  const app = new Hono<AppEnv>();

  // 1. IP blocking (first -- reject early)
  app.use('*', ipBlocker);

  // 2. Security headers
  app.use('*', defaultSecurityHeaders);
  app.use('*', apiSecurityHeaders);

  // 3. CORS
  app.use('*', isProduction ? prodCors : devCors);

  // 4. Body size limits
  app.use('*', bodyLimit({ maxSize: 1024 * 1024 }));

  // 5. Global rate limiting
  app.use('*', rateLimit({ windowMs: 60000, max: 100 }));

  // 6. Stricter rate limiting on auth
  app.use(
    '/auth/*',
    rateLimit({ windowMs: 900000, max: 10 }),
  );

  // 7. Request logging
  app.use('*', logger());

  // 8. Database injection
  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });

  // 9. Error handler
  app.onError(errorHandler);

  // Routes
  app.route('/auth', authRoutes());
  app.route('/books', booksRoutes());
  app.route('/orders', ordersRoutes());
  app.route('/users', usersRoutes());

  // Health check (no auth required)
  app.get('/health', (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString() }),
  );

  return app;
}
```

## Output

| Artifact | Location | Description |
|---|---|---|
| Rate limiter | `api/src/middleware/rate-limit.ts` | Configurable rate limiting |
| CORS config | `api/src/middleware/cors-config.ts` | Environment-specific CORS |
| Security headers | `api/src/middleware/security-headers.ts` | CSP, HSTS, and more |
| IP blocker | `api/src/middleware/ip-block.ts` | IP-based access control |
| Input sanitizer | `api/src/lib/sanitize.ts` | XSS prevention |
| Audit report | Console output | Dependency vulnerability report |

## Integration

| Skill | Relationship |
|---|---|
| `api-authentication` | Rate limiting on auth endpoints, brute force protection |
| `route-generation` | Security middleware in the middleware stack |
| `deployment-config-generator` | CORS origins and security config per environment |
| `api-testing-verification` | Security-focused test cases |
| `api-performance` | Rate limiting and caching work together |

### Security Checklist for Production

Before deploying to production, verify:

1. All auth endpoints have strict rate limiting.
2. CORS is configured with specific allowed origins (not `*`).
3. Security headers are present on all responses.
4. No raw SQL queries with user input exist.
5. JWT secrets are at least 32 characters and stored as environment secrets.
6. Error responses do not leak internal details or stack traces.
7. Request body size limits are configured.
8. `pnpm audit` shows no high or critical vulnerabilities.
9. All environment variables use the `.env.example` template.
10. Logging does not include sensitive data (passwords, tokens, PII).
