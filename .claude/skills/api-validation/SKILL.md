---
name: api-validation
description: >
  Zod schemas and request/response validation middleware for Hono APIs. Generates
  Zod schemas from Drizzle tables using drizzle-zod, creates request validation
  middleware for body, query params, and path params, adds response validation in
  dev/test mode, and attaches OpenAPI metadata to Zod schemas. Keywords: zod,
  validation, middleware, schema, request, response, body, query, params, drizzle-zod,
  hono-zod-validator, sanitize, parse, coerce, transform, error-format
---

# API Validation

## Purpose

Provides comprehensive request and response validation for Hono APIs using Zod.
Generates type-safe validation schemas from Drizzle ORM tables, creates reusable
validation middleware, implements consistent error formatting, and supports
OpenAPI metadata generation from Zod schemas.

## When to Use

- Setting up validation for new API endpoints.
- Creating Zod schemas from Drizzle table definitions.
- Implementing custom validation rules beyond basic type checking.
- Adding response validation for development/testing.
- The user says "validate", "zod schema", "request validation", or "error format".

## Inputs

| Input | Required | Description |
|---|---|---|
| Drizzle schemas | Yes | `api/src/db/schema/*.ts` from Phase 1 |
| Endpoint definitions | Yes | From build-spec.json or existing routes |

## Steps

### Step 1 -- Install Dependencies

```bash
cd api && pnpm add zod drizzle-zod @hono/zod-validator
```

### Step 2 -- Generate Zod Schemas from Drizzle

Use `drizzle-zod` to create base schemas, then refine with custom validation:

```typescript
// api/src/validators/users.ts
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { users } from '../db/schema/users';

// Insert schema -- used for creating new records
export const insertUserSchema = createInsertSchema(users, {
  // Override auto-generated validators with custom ones
  email: z.string().email('Must be a valid email address').toLowerCase().trim(),
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be under 100 characters')
    .trim(),
  role: z.enum(['admin', 'manager', 'customer']).optional().default('customer'),
}).omit({
  // Omit auto-generated fields
  id: true,
  createdAt: true,
  updatedAt: true,
  passwordHash: true,
});

// Select schema -- used for response validation
export const selectUserSchema = createSelectSchema(users).omit({
  passwordHash: true, // Never expose password hash
});

// Update schema -- all fields optional (partial)
export const updateUserSchema = insertUserSchema.partial();

// Registration schema -- extends insert with password field
export const registerUserSchema = insertUserSchema.extend({
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be under 128 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one digit'),
});

// Login schema
export const loginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1, 'Password is required'),
});

// Type inference -- use these throughout the codebase
export type InsertUser = z.infer<typeof insertUserSchema>;
export type SelectUser = z.infer<typeof selectUserSchema>;
export type UpdateUser = z.infer<typeof updateUserSchema>;
export type RegisterUser = z.infer<typeof registerUserSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
```

### Step 3 -- Shared Validation Schemas

```typescript
// api/src/validators/shared.ts
import { z } from 'zod';

// UUID path parameter
export const uuidParamSchema = z.object({
  id: z.string().uuid('Invalid ID format'),
});

// Pagination query parameters
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Sort query parameters (generic)
export const sortQuerySchema = z.object({
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// Search query parameter
export const searchQuerySchema = z.object({
  search: z.string().max(200).optional(),
  q: z.string().max(200).optional(),
});

// Date range filter
export const dateRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// Combined list query
export function createListQuerySchema<T extends z.ZodRawShape>(
  sortFields: [string, ...string[]],
  extraFields?: T,
) {
  return paginationQuerySchema
    .merge(
      z.object({
        sortBy: z.enum(sortFields).default(sortFields[0]),
        sortOrder: z.enum(['asc', 'desc']).default('desc'),
        search: z.string().max(200).optional(),
      }),
    )
    .merge(extraFields ? z.object(extraFields) : z.object({}));
}

// Paginated response wrapper
export function createPaginatedResponseSchema<T extends z.ZodType>(
  itemSchema: T,
) {
  return z.object({
    data: z.array(itemSchema),
    meta: z.object({
      page: z.number().int(),
      limit: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    }),
  });
}

// Error response schema
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z
      .array(
        z.object({
          path: z.string(),
          message: z.string(),
          code: z.string(),
        }),
      )
      .optional(),
  }),
});

export type UuidParam = z.infer<typeof uuidParamSchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
```

### Step 4 -- Hono Zod Validator Integration

```typescript
// api/src/routes/books.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppEnv } from '../app';
import {
  insertBookSchema,
  updateBookSchema,
  listBooksQuerySchema,
} from '../validators/books';
import { uuidParamSchema } from '../validators/shared';

export function booksRoutes() {
  const router = new Hono<AppEnv>();

  // Validate query parameters
  router.get(
    '/',
    zValidator('query', listBooksQuerySchema),
    async (c) => {
      const query = c.req.valid('query'); // fully typed and validated
      // ...
    },
  );

  // Validate path parameters
  router.get(
    '/:id',
    zValidator('param', uuidParamSchema),
    async (c) => {
      const { id } = c.req.valid('param'); // string & uuid validated
      // ...
    },
  );

  // Validate JSON body
  router.post(
    '/',
    zValidator('json', insertBookSchema),
    async (c) => {
      const data = c.req.valid('json'); // typed as InsertBook
      // ...
    },
  );

  // Validate both params and body
  router.patch(
    '/:id',
    zValidator('param', uuidParamSchema),
    zValidator('json', updateBookSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const data = c.req.valid('json'); // typed as Partial<InsertBook>
      // ...
    },
  );

  return router;
}
```

### Step 5 -- Custom Error Formatting

```typescript
// api/src/middleware/validation-error-handler.ts
import { z } from 'zod';

// Custom error map for consistent formatting
export const customErrorMap: z.ZodErrorMap = (issue, ctx) => {
  // Provide user-friendly error messages
  switch (issue.code) {
    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') {
        return {
          message: `Must be at least ${issue.minimum} character${issue.minimum === 1 ? '' : 's'}`,
        };
      }
      if (issue.type === 'number') {
        return { message: `Must be at least ${issue.minimum}` };
      }
      break;
    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') {
        return { message: `Must be at most ${issue.maximum} characters` };
      }
      break;
    case z.ZodIssueCode.invalid_type:
      return {
        message: `Expected ${issue.expected}, received ${issue.received}`,
      };
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === 'email') {
        return { message: 'Must be a valid email address' };
      }
      if (issue.validation === 'uuid') {
        return { message: 'Must be a valid UUID' };
      }
      break;
  }
  return { message: ctx.defaultError };
};

// Set globally
z.setErrorMap(customErrorMap);

// Format Zod errors into consistent API error response
export function formatZodError(error: z.ZodError) {
  return {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: error.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
        code: e.code,
      })),
    },
  };
}

// Custom hook for @hono/zod-validator to use our error format
export function validationHook(result: any, c: any) {
  if (!result.success) {
    return c.json(formatZodError(result.error), 400);
  }
}
```

### Step 6 -- Response Validation (Dev/Test Mode)

```typescript
// api/src/middleware/response-validator.ts
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { AppEnv } from '../app';

// Only active in development/test -- validates response shapes
export function validateResponse<T extends z.ZodType>(schema: T) {
  return createMiddleware<AppEnv>(async (c, next) => {
    await next();

    // Only validate in dev/test
    const env = process.env.NODE_ENV ?? 'development';
    if (env === 'production') return;

    // Only validate JSON responses
    const contentType = c.res.headers.get('content-type');
    if (!contentType?.includes('application/json')) return;

    try {
      const body = await c.res.clone().json();
      const result = schema.safeParse(body);
      if (!result.success) {
        console.warn(
          'Response validation warning:',
          JSON.stringify(result.error.errors, null, 2),
        );
      }
    } catch {
      // Ignore parsing errors
    }
  });
}
```

### Step 7 -- Advanced Patterns

**Pick and Omit for different endpoints:**

```typescript
// Create a schema for a "public" book view (no stock info)
export const publicBookSchema = selectBookSchema.omit({ stock: true });

// Create a schema for admin book view (includes everything)
export const adminBookSchema = selectBookSchema;

// Schema for book search results (subset of fields)
export const bookSearchResultSchema = selectBookSchema.pick({
  id: true,
  title: true,
  author: true,
  price: true,
});
```

**Transform and preprocess:**

```typescript
// Transform input before validation
export const createBookSchema = insertBookSchema.transform((data) => ({
  ...data,
  isbn: data.isbn.replace(/-/g, ''), // Remove dashes from ISBN
  title: data.title.trim(),
  author: data.author.trim(),
}));

// Coerce string query params to proper types
export const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  minPrice: z.coerce.number().positive().optional(),
  maxPrice: z.coerce.number().positive().optional(),
  inStock: z
    .string()
    .transform((v) => v === 'true')
    .optional(),
});
```

**Discriminated unions for polymorphic requests:**

```typescript
// Different validation based on auth type
const authRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('password'),
    email: z.string().email(),
    password: z.string().min(8),
  }),
  z.object({
    type: z.literal('api_key'),
    apiKey: z.string().min(32),
  }),
  z.object({
    type: z.literal('oauth'),
    provider: z.enum(['google', 'github']),
    code: z.string(),
  }),
]);
```

## Output

| Artifact | Location | Description |
|---|---|---|
| Validator schemas | `api/src/validators/*.ts` | Zod schemas per resource |
| Shared schemas | `api/src/validators/shared.ts` | Reusable pagination, UUID, error schemas |
| Error formatter | `api/src/middleware/validation-error-handler.ts` | Consistent error formatting |
| Response validator | `api/src/middleware/response-validator.ts` | Dev-mode response checking |

## Integration

| Skill | Relationship |
|---|---|
| `database-design` | Zod schemas generated from Drizzle tables |
| `route-generation` | Validators used in route handler middleware |
| `api-documentation` | Zod schemas used to generate OpenAPI spec |
| `tdd-from-schema` | Test assertions match validation error format |
| `api-authentication` | Login/register schemas defined here |
