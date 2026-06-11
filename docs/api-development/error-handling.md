# Error Handling

How Nerva APIs report failure -- one envelope shape for every error response, the typed error classes and global `app.onError()` handler that produce it, what each error category looks like on the wire, and how the format relates to RFC 9457 Problem Details.

Inconsistent error formats are a top complaint from API consumers, because errors are where client code meets reality: a form that displays validation messages, a retry loop backing off on 429s, and an engineer chasing a 500 through logs all parse the same responses. When every endpoint returns the same shape, each of those is written once. The schema-to-api pipeline generates this machinery in Phase 3 (`api/src/middleware/error-handler.ts`), and the Phase 2 TDD tests pin the response shapes before any handler exists -- this guide is the reference for both, and for APIs written by hand.

## The Standard Error Shape

Every non-2xx response carries a single top-level `error` object:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "field": "email", "message": "Invalid email format" }
    ]
  }
}
```

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `code` | `string` | Yes | Stable, machine-readable identifier in UPPER_SNAKE_CASE. Clients branch on this -- never on `message`. |
| `message` | `string` | Yes | Human-readable explanation, safe to log or show to a technical user. Answers "what went wrong" and, where possible, "how do I fix it". |
| `details` | `array \| object` | No | Structured, code-specific context. For `VALIDATION_ERROR` it is an array of field-level errors; the shape varies by code and is documented per code. |
| `requestId` | `string` | No | Correlates this response with server-side logs. Included automatically once the request-id middleware is wired up. |

Three rules keep the format trustworthy:

- **Codes are a contract.** Never change what a code means -- consumers build retry logic, error mapping, and user-facing copy on them. If the meaning changes, add a new code.
- **Messages are prose, codes are protocol.** Reword a message freely; a client that string-matches messages is already broken. Anything a client needs to act on belongs in `code` or `details`.
- **Nothing internal leaks.** No stack traces, no driver errors, no file paths, no dependency names. Those go to server-side logs; the response gets the sanitized version.

### Where `error` Sits in the Envelope

The response envelope is defined in `.claude/pipeline.config.json`:

```json
"envelope": {
  "dataField": "data",
  "metaField": "meta",
  "errorField": "error"
}
```

Success responses put the payload in `data` (plus `meta` for pagination); failures put the error object in `error`. The fields never appear together. A list endpoint succeeds like this:

```json
{
  "data": [{ "id": 1, "title": "The Pragmatic Programmer" }],
  "meta": { "page": 1, "limit": 20, "total": 137, "totalPages": 7 }
}
```

and fails like this:

```json
{
  "error": { "code": "NOT_FOUND", "message": "Book with ID 999 not found" }
}
```

Clients branch on the HTTP status, then read the matching field: a 2xx always has `data`, anything else always has `error`.

## Error Code Registry

| Code | HTTP Status | When |
|------|-------------|------|
| `VALIDATION_ERROR` | 400 | Request body, query, or path params failed schema validation |
| `UNAUTHORIZED` | 401 | Missing, expired, or invalid authentication |
| `FORBIDDEN` | 403 | Authenticated, but not allowed to perform this action |
| `NOT_FOUND` | 404 | Resource or route does not exist |
| `CONFLICT` | 409 | Request conflicts with current state -- duplicate value, stale update, invalid state transition |
| `PAYLOAD_TOO_LARGE` | 413 | Request body exceeds the configured size limit |
| `RATE_LIMITED` | 429 | Too many requests in the current window |
| `INTERNAL_ERROR` | 500 | Unexpected server error -- a bug, by definition |

### Error Code Constants

Define the registry once as a const object and derive a union type from it:

```typescript
// api/src/middleware/error-handler.ts
export const ErrorCodes = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
```

This buys three things over scattered string literals: a typo in a code is a compile error instead of a silently unmatchable response; the registry table above and the object stay in lockstep because there is exactly one place to edit; and the union type can be mirrored into the generated API client so Aurelius frontends switch over codes exhaustively.

Domain-specific codes (an order service might need `INSUFFICIENT_STOCK`) are added to the same object. Add a new code only when a client would handle it differently from the generic one -- if the client's behavior is identical, reuse the generic code and put the specifics in `message` and `details`.

## Typed Error Classes

Handlers and services signal failure by throwing, never by hand-building error JSON. `AppError` carries the status, code, and optional details; subclasses cover the common cases:

```typescript
// api/src/middleware/error-handler.ts
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class AppError extends Error {
  constructor(
    public readonly statusCode: ContentfulStatusCode,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string | number) {
    super(
      404,
      ErrorCodes.NOT_FOUND,
      id ? `${resource} with ID ${id} not found` : `${resource} not found`,
    );
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, ErrorCodes.CONFLICT, message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, ErrorCodes.UNAUTHORIZED, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Insufficient permissions", details?: unknown) {
    super(403, ErrorCodes.FORBIDDEN, message, details);
  }
}
```

Typing `statusCode` as `ContentfulStatusCode` (from `hono/utils/http-status`) rather than `number` matters: it is the status type `c.json()` accepts, so the global handler below compiles without a cast.

In a route handler, failure is one line:

```typescript
// api/src/routes/books.ts
booksRoutes.get("/:id", async (c) => {
  const book = await bookService.findById(c.req.param("id"));
  if (!book) {
    throw new NotFoundError("Book", c.req.param("id"));
  }
  return c.json({ data: book });
});
```

Throwing instead of returning keeps serialization in exactly one place -- the global handler -- so the shape cannot drift between endpoints, and services can signal failures without knowing anything about HTTP responses.

## Global Error Handling with `app.onError()`

Hono routes every error thrown by a handler or middleware to the function registered with `app.onError()`. One handler serializes all of them:

```typescript
// api/src/middleware/error-handler.ts
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import type { AppEnv } from "../app";

const HTTP_STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  400: ErrorCodes.VALIDATION_ERROR,
  401: ErrorCodes.UNAUTHORIZED,
  403: ErrorCodes.FORBIDDEN,
  404: ErrorCodes.NOT_FOUND,
  409: ErrorCodes.CONFLICT,
  413: ErrorCodes.PAYLOAD_TOO_LARGE,
  429: ErrorCodes.RATE_LIMITED,
};

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get("requestId");

  // 1. Zod validation errors -- thrown by the zValidator hook
  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: "Request validation failed",
          details: err.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
          requestId,
        },
      },
      400,
    );
  }

  // 2. Application errors -- thrown by handlers and services
  if (err instanceof AppError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
          requestId,
        },
      },
      err.statusCode,
    );
  }

  // 3. HTTPException -- thrown by Hono's built-in middleware
  if (err instanceof HTTPException) {
    return c.json(
      {
        error: {
          code: HTTP_STATUS_TO_CODE[err.status] ?? ErrorCodes.INTERNAL_ERROR,
          message: err.message || "Request failed",
          requestId,
        },
      },
      err.status,
    );
  }

  // 4. Anything else is a bug -- log everything, reveal nothing
  console.error("Unhandled error:", err);
  return c.json(
    {
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: "An unexpected error occurred",
        requestId,
      },
    },
    500,
  );
};
```

(`requestId` is `undefined` until the middleware below is wired up; `JSON.stringify` drops undefined fields, so the envelope stays clean either way.)

Branch 3 is the one most implementations miss. Hono's own middleware throws `HTTPException` -- `hono/jwt` throws 401s for missing or invalid tokens, `bodyLimit` throws 413s. Without that branch they fall through to branch 4, and a missing token reports as a 500 `INTERNAL_ERROR` -- exactly the inconsistency this guide exists to prevent. One caveat: some exceptions carry their own response (`err.getResponse()`) with headers such as `WWW-Authenticate`; if your clients depend on those headers, copy them onto the JSON response.

Branch 4 returns a fixed message and never echoes `err.message`: messages of unexpected errors routinely contain connection strings, SQL fragments, and file paths. Log the full error server-side and watch how often this branch fires -- every hit is a failure mode that deserves a typed error, and the ratio of unhandled to handled errors is a code-quality metric.

### Unmatched Routes

`app.onError()` never sees requests that match no route -- Hono answers those itself with a plain-text 404. Register `app.notFound()` so even those responses use the envelope:

```typescript
app.notFound((c) =>
  c.json(
    { error: { code: ErrorCodes.NOT_FOUND, message: "Route not found" } },
    404,
  ),
);
```

### Wiring It Up

The app factory registers the request-id middleware, the error handler, and the not-found handler together:

```typescript
// api/src/app.ts
import { Hono } from "hono";
import { requestId, type RequestIdVariables } from "hono/request-id";
import type { Database } from "./db";
import { booksRoutes } from "./routes/books";
import { ErrorCodes, errorHandler } from "./middleware/error-handler";

export type AppEnv = {
  Variables: RequestIdVariables & {
    db: Database;
    userId: string;
    userRole: string;
  };
};

export function createApp({ db }: { db: Database }) {
  const app = new Hono<AppEnv>();

  // Accept an incoming X-Request-Id or generate one, then echo it on
  // every response so consumers can quote it in bug reports
  app.use("*", requestId());
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Request-Id", c.get("requestId"));
  });

  app.onError(errorHandler);

  app.route("/api/v1/books", booksRoutes());

  app.notFound((c) =>
    c.json(
      { error: { code: ErrorCodes.NOT_FOUND, message: "Route not found" } },
      404,
    ),
  );

  return app;
}
```

With this in place, `requestId` appears in every error body and as an `X-Request-Id` header on every response -- the single most useful field for debugging, because it connects a consumer's error report to the exact server-side log entry.

## Error Categories

What each category looks like on the wire, and how it is produced.

### Validation Errors (400)

There is a trap here: `@hono/zod-validator` ships its own 400 response, and its default shape is Zod's raw error structure -- not the envelope. Override the hook so failures throw instead, and the global handler owns serialization end to end:

```typescript
// api/src/middleware/validate.ts
import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";

// zValidator with the default hook replaced: failures throw the ZodError
// so the global error handler formats them into the standard envelope
export const validate = <T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      throw result.error;
    }
  });
```

Routes use `validate()` exactly like `zValidator()`:

```typescript
booksRoutes.post("/", validate("json", createBookSchema), async (c) => {
  const input = c.req.valid("json");
  // ...
});
```

A request with a malformed email and a missing title produces:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "field": "email", "message": "Invalid email format" },
      { "field": "title", "message": "Required" }
    ],
    "requestId": "1f1bb2a8-3ac2-4f3f-bf1a-4a2353e4c52f"
  }
}
```

`field` is the dotted path into the request (`address.city`, `items.0.quantity` for array elements), so frontends can attach each message to the right form input. Query and path param validation flows through the same branch and produces the same shape.

### Authentication Errors (401)

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

These arise two ways: Hono's `jwt()` and `bearerAuth()` middleware throw `HTTPException(401)`, which branch 3 of the handler maps to `UNAUTHORIZED`; custom auth middleware throws `new UnauthorizedError()` with a more specific message such as "Token expired".

Be precise about what the message reveals. "Token expired" is fine -- it tells a legitimate client to refresh. "User not found" or "Wrong password" is not: confirming which half of a credential pair failed halves an attacker's work. Login failures always say "Invalid credentials".

The boundary with 403: a 401 means "I don't know who you are -- try again with credentials"; a 403 means "I know exactly who you are, and the answer is no".

### Authorization Errors (403)

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Insufficient permissions",
    "details": { "requiredRole": "admin" }
  }
}
```

Produced by role-checking middleware:

```typescript
// api/src/middleware/require-role.ts
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app";
import { ForbiddenError } from "./error-handler";

export function requireRole(role: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.get("userRole") !== role) {
      throw new ForbiddenError("Insufficient permissions", { requiredRole: role });
    }
    await next();
  });
}
```

Include what the caller needs in order to act -- the required role or permission -- whenever that is not itself sensitive. For resources whose very existence is private, do not return 403 at all; see the next section.

### Not Found (404)

Two sources, one shape: a handler throws `NotFoundError` when a looked-up resource does not exist, and `app.notFound()` covers URLs that match no route.

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Book with ID 999 not found"
  }
}
```

Specific, ID-bearing messages are right for callers accessing their own data. But when a caller is not entitled to know whether a resource exists -- another tenant's order, another user's profile -- return 404 with a generic message rather than 403: a 403 confirms the resource is there, which is exactly the information an enumeration attack wants.

### Conflict (409)

For duplicate unique values, stale optimistic-lock updates, and invalid state transitions. The message names the conflict and, ideally, the way out:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "A book with ISBN 978-0135957059 already exists"
  }
}
```

Translate driver errors into `ConflictError` in the service layer so they surface as 409s instead of 500s:

```typescript
try {
  const [book] = await db.insert(books).values(input).returning();
  return book;
} catch (err) {
  if (isUniqueViolation(err)) {
    throw new ConflictError(`A book with ISBN ${input.isbn} already exists`);
  }
  throw err;
}
```

where `isUniqueViolation` checks for Postgres error code `23505` (on the error or its `cause`, depending on driver and ORM version).

### Rate Limiting (429)

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Try again in 42 seconds."
  }
}
```

Rate limiting is enforced in middleware, which already holds the context -- so it returns the envelope directly rather than throwing (same shape either way; `bodyLimit`'s 413 handler works the same):

```typescript
if (entry.count > max) {
  c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
  return c.json(
    { error: { code: ErrorCodes.RATE_LIMITED, message } },
    429,
  );
}
```

The headers do half the work for well-behaved clients: `Retry-After` says how many seconds to wait, and `X-RateLimit-Limit` / `X-RateLimit-Remaining` let clients back off before ever hitting a 429. Browser-based clients can only read those headers if CORS exposes them -- list them in `exposeHeaders` as shown in the [CORS configuration guide](./cors-configuration.md).

### Server Errors (500)

Branch 4 of the global handler: anything not recognized as a typed error. The response is always the same, no matter what actually broke:

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred",
    "requestId": "1f1bb2a8-3ac2-4f3f-bf1a-4a2353e4c52f"
  }
}
```

Everything specific goes to the server-side log: the full error with stack trace, the method and path, and the user ID when authenticated -- keyed by the same `requestId` the consumer received, so "it failed, requestId `1f1bb2a8...`" is enough to find the exact log entry. On Cloudflare Workers, stream those logs with `npx wrangler tail`; note that an error thrown *outside* the Hono app (or a crash before `onError` runs) gets Cloudflare's own error page instead of the envelope -- and since that page has no CORS headers, browsers misreport it as a CORS failure.

Every 500 is a bug by definition. When one recurs, give it a typed error class and the right 4xx status -- the unhandled branch should be approaching silent in a healthy API.

## Testing Error Responses

The TDD phase pins error shapes the same way it pins success shapes -- shared helpers assert the envelope so every endpoint's tests stay consistent:

```typescript
// api/tests/helpers/errors.ts
import { expect } from "vitest";

export function expectErrorShape(body: unknown, code: string) {
  expect(body).toHaveProperty("error");
  const { error } = body as { error: { code: string; message: string } };
  expect(error.code).toBe(code);
  expect(typeof error.message).toBe("string");
}
```

```typescript
// api/tests/integration/books.test.ts
it("returns the standard envelope for validation failures", async () => {
  const res = await app.request("/api/v1/books", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "" }),
  });

  expect(res.status).toBe(400);
  const body = await res.json();
  expectErrorShape(body, "VALIDATION_ERROR");
  expect(Array.isArray(body.error.details)).toBe(true);
});
```

Two cases worth testing on every API regardless of resources: an unmatched route returns the `NOT_FOUND` envelope (proves `app.notFound()` is registered), and a handler that throws an unexpected error returns the generic `INTERNAL_ERROR` message with no stack trace or original message in the body (proves nothing leaks).

## RFC 9457 Problem Details

[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) (Problem Details for HTTP APIs, obsoleting RFC 7807) is the IETF standard for machine-readable error responses, and Nerva's format follows its design. The RFC defines a `application/problem+json` document with five members; each has a direct counterpart:

| RFC 9457 member | Purpose | Nerva equivalent |
|-----------------|---------|------------------|
| `type` | URI identifying the problem type | `error.code` -- a registry token instead of a URI |
| `title` | Short, stable summary of the problem type | the registry description for `error.code` (documented once here, not repeated per response) |
| `status` | HTTP status code | the response status line, not duplicated in the body |
| `detail` | Human-readable explanation of this occurrence | `error.message` |
| `instance` | URI identifying this occurrence | `error.requestId` |
| *extension members* | Type-specific structured data | `error.details` -- the RFC's own validation example uses an `errors` extension array naming each failing field, which is precisely Nerva's `details` |

The principles carried over are the ones that matter: a stable machine-readable identity separate from human-readable prose, "what kind of problem" (`code`) separate from "what happened this time" (`message`), per-occurrence correlation, and structured extensions instead of data smuggled into message strings.

Where Nerva deliberately diverges is the envelope. RFC 9457 puts its members at the top level of the body under a dedicated content type, which would make parsing an error response different from parsing a success response. Nerva responses always have exactly one of `data` or `error` at the top level, so clients -- including the generated Aurelius API client -- parse every response the same way. Skipping `type` URIs also avoids the RFC's implied obligation to host dereferenceable documentation pages per error type; the registry table above plays that role.

If a consumer requires strict RFC 9457 compliance -- some enterprise and government integrations standardize on `application/problem+json` -- the global handler is the single place to change: emit the members at the top level, set the `Content-Type` header, map `code` to a type URI (`https://api.example.com/problems/validation-error`), `message` to `detail`, and `details` to an extension member. The error classes, codes, and every throw site stay exactly as they are.

## Further Reading

- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457) -- the standard this format draws on
- [Hono: HTTPException](https://hono.dev/docs/api/exception) -- what Hono's built-in middleware throws
- [Hono: Request ID middleware](https://hono.dev/docs/middleware/builtin/request-id) -- the source of `requestId`
- [CORS configuration guide](./cors-configuration.md) -- exposing rate-limit headers to browsers, and platform error pages that masquerade as CORS failures
- [API Development Standards](./README.md#error-handling) -- the summary table in the standards index
