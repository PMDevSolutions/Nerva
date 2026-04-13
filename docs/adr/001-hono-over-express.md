# ADR-001: Hono as HTTP Framework Over Express

## Status

Accepted

## Date

2026-03-29

## Context

Nerva needs an HTTP framework that supports both Cloudflare Workers (edge) and Node.js deployment targets from a single codebase. The framework must handle typed middleware composition, request validation with Zod, and JWT authentication — all with strong TypeScript support.

Express is the most popular Node.js HTTP framework with the largest ecosystem. However, it was designed before TypeScript, before edge runtimes, and before the Web Standards API (`Request`/`Response`) became the common interface across JavaScript runtimes.

Key constraints:

- **Cloudflare Workers is the primary deployment target.** Workers have strict CPU time limits and no access to Node.js-specific APIs. Express depends on Node.js `http` module internals and cannot run on Workers without compatibility layers.
- **TypeScript strict mode is enforced.** The framework must provide strong type inference for routes, middleware, context, and environment bindings without requiring manual type annotations everywhere.
- **The pipeline generates code.** Nerva's schema-to-API pipeline produces route handlers, middleware, and validation code. The target framework must have predictable, composable patterns that generated code can follow consistently.

Alternatives considered:

- **Express** — Largest ecosystem, but Node.js-only. No native TypeScript support. Middleware typing is weak (`req: any`-style patterns). Would require a separate framework for Workers.
- **Fastify** — Strong TypeScript support and good performance on Node.js. However, it is Node.js-only and cannot run on Cloudflare Workers.
- **Elysia** — Bun-first framework with excellent TypeScript inference. However, it is tightly coupled to Bun runtime and does not support Cloudflare Workers.

## Decision

Use **Hono** as the HTTP framework for all generated APIs.

Hono is a lightweight, Web Standards-based framework that runs on Cloudflare Workers, Node.js, Deno, and Bun with zero adapter code. It provides typed route definitions, first-class middleware composition via `app.use()`, and built-in integrations for Zod validation (`@hono/zod-validator`) and JWT (`hono/jwt`).

## Consequences

### Positive

- **Single framework for both deployment targets.** The same route handlers run on Cloudflare Workers and Node.js without modification.
- **Native TypeScript inference.** Route parameters, context bindings, and middleware outputs are fully typed. The `Hono<{ Bindings: Env }>` pattern provides compile-time safety for environment variables.
- **Built-in Zod integration.** `@hono/zod-validator` provides request validation middleware that feeds typed data into handlers, which aligns with the pipeline's Zod-first validation approach.
- **Minimal bundle size.** Hono's core is under 15KB, well within Workers bundle limits.
- **Testing without a server.** `app.request()` enables integration testing by sending requests directly to the app instance — no need to start a real HTTP server.

### Negative

- **Smaller ecosystem than Express.** Many npm packages assume Express middleware signatures (`req, res, next`). Some third-party integrations require adaptation.
- **Smaller community.** Less Stack Overflow coverage and fewer tutorials compared to Express. Debugging unfamiliar edge cases may require reading Hono source code.
- **Workers-specific patterns.** Cloudflare bindings (D1, KV, Durable Objects) are accessed via Hono's context rather than global imports, which is unfamiliar to developers coming from traditional Node.js.

### Neutral

- Hono's middleware signature differs from Express (`c, next` instead of `req, res, next`). Developers need to learn the new convention but it is straightforward.
