# Migrating from Express to Nerva (Hono)

A side-by-side guide for Express developers moving to Nerva. Every Express pattern you know has a direct Hono equivalent — this maps them one to one, explains the handful of places where the mental model genuinely differs, and shows what Nerva layers on top once you arrive.

If you want the rationale for choosing Hono over Express in the first place, see [ADR-001: Hono as HTTP Framework Over Express](../adr/001-hono-over-express.md). This guide is about *how* to make the move, not *whether* to.

## The One Mental-Model Shift

Almost everything else follows from a single difference, so it is worth stating up front.

**Express mutates a response object. Hono returns a response.**

```javascript
// Express — you mutate `res` and the framework sends it for you
app.get("/hello", (req, res) => {
  res.status(200).json({ message: "hi" });
});
```

```typescript
// Hono — you return a Response; there is one context object `c`, not two
app.get("/hello", (c) => {
  return c.json({ message: "hi" }, 200);
});
```

Three consequences fall out of this, and they account for most of the friction Express developers hit:

- **There is one context object, `c`, not separate `req` and `res`.** Request data lives under `c.req`; you build responses with helpers on `c` like `c.json()`. The middleware signature is `(c, next)`, not `(req, res, next)`.
- **You must `return` the response.** Forgetting `return` is the single most common porting bug. In Express, `res.json()` sends immediately and the function's return value is ignored. In Hono, the handler's return value *is* the response — drop the `return` and the route falls through.
- **Hono is built on Web Standards (`Request`/`Response`), not Node's `http` module.** That is why the same handler runs unmodified on Cloudflare Workers, Node.js, Deno, and Bun. It is also why reading the body is asynchronous (`await c.req.json()`) and why `process.env` is not always available — more on both below.

Keep that shift in mind and the rest of this guide is mechanical translation.

## Cheat Sheet

The quick reference. Each row is expanded with context and caveats in the sections that follow.

| Concern | Express | Hono (Nerva) |
|---------|---------|--------------|
| Create app | `const app = express()` | `const app = new Hono()` |
| Start server | `app.listen(3000)` | `serve({ fetch: app.fetch, port: 3000 })` (Node) / `export default app` (Workers) |
| Define route | `app.get("/u", handler)` | `app.get("/u", handler)` |
| Path param | `req.params.id` | `c.req.param("id")` |
| Query string | `req.query.q` | `c.req.query("q")` |
| Read header | `req.get("X-Foo")` | `c.req.header("X-Foo")` |
| JSON body | `req.body` (after `express.json()`) | `await c.req.json()` |
| Form body | `req.body` (after `urlencoded()`) | `await c.req.parseBody()` |
| Send JSON | `res.json(obj)` | `return c.json(obj)` |
| Send text | `res.send("ok")` | `return c.text("ok")` |
| Set status | `res.status(201).json(x)` | `return c.json(x, 201)` |
| Set header | `res.set("X-Foo", "bar")` | `c.header("X-Foo", "bar")` |
| Redirect | `res.redirect("/login")` | `return c.redirect("/login")` |
| Register middleware | `app.use(mw)` | `app.use("*", mw)` |
| Middleware signature | `(req, res, next) => {}` | `async (c, next) => { await next() }` |
| Pass control | `next()` | `await next()` |
| Mount sub-router | `app.use("/u", router)` | `app.route("/u", routes)` |
| Router instance | `express.Router()` | `new Hono()` |
| Error handler | `app.use((err, req, res, next) => {})` | `app.onError((err, c) => {})` |
| 404 handler | trailing `app.use(...)` | `app.notFound((c) => {})` |
| Throw HTTP error | `next(createError(404))` | `throw new HTTPException(404)` |
| Static files | `express.static("public")` | `serveStatic({ root: "./public" })` |
| Env var | `process.env.X` | `process.env.X` (Node) / `c.env.X` (Workers) |
| CORS | `cors()` (npm `cors`) | `cors()` (`hono/cors`, built in) |
| Body limit | `express.json({ limit })` | `bodyLimit({ maxSize })` (`hono/body-limit`) |

## App Setup and Middleware Registration

In Express, you create an app and stack global middleware with `app.use()` before mounting routes:

```javascript
// Express
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");

const app = express();

app.use(morgan("dev"));      // logging
app.use(cors());             // CORS
app.use(helmet());           // security headers
app.use(express.json());     // body parsing

app.use("/health", healthRouter);
```

Hono is the same shape, with two differences: middleware are imported from `hono/*` (no separate npm packages for the common ones), and `app.use()` takes a path pattern as its first argument — use `"*"` to match everything. This is the actual setup Nerva generates for the Node target:

```typescript
// Hono (Nerva — Node target, api/src/index.ts)
import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { healthRoutes } from "./routes/health";

const app = new Hono();

app.use("*", logger());        // morgan
app.use("*", cors());          // cors
app.use("*", compress());      // compression
app.use("*", etag());          // etag
app.use("*", secureHeaders()); // helmet
app.use("*", requestId());     // adds a request id to every request

app.route("/health", healthRoutes);
```

There is no `express.json()` line. Hono does not parse the body into `req.body` ahead of time — you read it on demand inside the handler with `await c.req.json()`, so there is nothing to register globally. (Nerva's validation layer, built on `@hono/zod-validator`, does the parse-and-validate step per route instead. See [API validation](../api-development/README.md#hono-patterns).)

Two `app.use("*", ...)` calls in the example above replace whole npm dependencies you would install separately for Express: `secureHeaders()` stands in for `helmet`, and `cors()` for the `cors` package. Both ship inside Hono.

## Route Definition

Routing is the part that needs almost no translation. The method-name API is identical:

```javascript
// Express
app.get("/users", listUsers);
app.post("/users", createUser);
app.put("/users/:id", updateUser);
app.patch("/users/:id", patchUser);
app.delete("/users/:id", deleteUser);
```

```typescript
// Hono — same method names, same path syntax
app.get("/users", listUsers);
app.post("/users", createUser);
app.put("/users/:id", updateUser);
app.patch("/users/:id", patchUser);
app.delete("/users/:id", deleteUser);
```

Path parameters use the same `:param` syntax. Hono also supports optional params (`/users/:id?`), regex constraints (`/users/:id{[0-9]+}`), and wildcards (`/files/*`) — a superset of what Express path patterns cover.

Hono routes are also **chainable**, and Nerva leans on this to keep a resource's routes in one typed expression:

```typescript
// Hono — chaining keeps related routes together (and preserves type inference
// for the generated RPC client)
export const usersRoutes = new Hono()
  .get("/", listUsers)
  .get("/:id", getUser)
  .post("/", createUser)
  .put("/:id", updateUser)
  .delete("/:id", deleteUser);
```

## Request and Response Handling

This is where `c` replaces the `req`/`res` pair. Reading input:

| What you want | Express | Hono |
|---------------|---------|------|
| Path param | `req.params.id` | `c.req.param("id")` |
| All path params | `req.params` | `c.req.param()` |
| Query value | `req.query.page` | `c.req.query("page")` |
| All query values | `req.query` | `c.req.query()` |
| Header | `req.get("Authorization")` | `c.req.header("Authorization")` |
| JSON body | `req.body` | `await c.req.json()` |
| Form body | `req.body` | `await c.req.parseBody()` |
| Raw text body | `req.body` | `await c.req.text()` |
| Method / path | `req.method` / `req.path` | `c.req.method` / `c.req.path` |

The one that trips people up: **reading the body is asynchronous.** Express middleware parses the body before your handler runs, so `req.body` is just sitting there. Hono hands you the live request, so you `await` the parse:

```javascript
// Express — body already parsed by express.json()
app.post("/users", (req, res) => {
  const { email, name } = req.body;
  res.status(201).json({ email, name });
});
```

```typescript
// Hono — await the parse; return the response
app.post("/users", async (c) => {
  const { email, name } = await c.req.json();
  return c.json({ email, name }, 201);
});
```

A caveat that has no Express equivalent: **the body can only be read once.** `await c.req.json()` consumes the stream, so a second read throws. If you need the body in more than one place, read it once and pass the value along — which is exactly what Nerva's Zod validation middleware does, stashing the parsed-and-validated body so the handler retrieves it with `c.req.valid("json")` instead of re-reading.

Building output — the helpers live on `c`, and you `return` them:

```javascript
// Express
res.json({ ok: true });                 // JSON
res.status(201).json(created);          // JSON + status
res.send("plain text");                 // text
res.set("X-Total-Count", "42");         // header
res.redirect(302, "/login");            // redirect
res.status(204).end();                  // empty
```

```typescript
// Hono
return c.json({ ok: true });            // JSON
return c.json(created, 201);            // JSON + status
return c.text("plain text");            // text
c.header("X-Total-Count", "42");        // header (set before returning)
return c.redirect("/login", 302);       // redirect
return c.body(null, 204);               // empty
```

Note that `c.header()` is a statement that mutates the outgoing response, but the body helpers (`c.json`, `c.text`, `c.body`, `c.redirect`) produce the `Response` you must return. Set your headers first, then `return` the body.

## Middleware Patterns

Express middleware takes `(req, res, next)` and either calls `next()` to continue or sends a response to short-circuit. Hono middleware takes `(c, next)` and `await`s `next()`. The crucial upgrade: in Hono, `await next()` sits in the *middle* of your function, so the same middleware runs logic both **before** the handler (on the way in) and **after** it (on the way out) — no separate "response-finished" hook needed.

```javascript
// Express — timing needs a res.on("finish") listener for the "after" half
function timing(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} ${Date.now() - start}ms`);
  });
  next();
}
app.use(timing);
```

```typescript
// Hono — before and after live in one function, split by `await next()`
import { createMiddleware } from "hono/factory";

const timing = createMiddleware(async (c, next) => {
  const start = Date.now();
  await next();                    // run the rest of the chain + the handler
  const ms = Date.now() - start;   // back here once the handler has responded
  console.log(`${c.req.method} ${c.req.path} ${ms}ms`);
});

app.use("*", timing);
```

**Short-circuiting** is even simpler than Express: to stop the chain, just `return` a response and never call `await next()`. There is no `next()` you must remember *not* to call.

```javascript
// Express — return after sending so you don't call next()
function requireApiKey(req, res, next) {
  if (req.get("X-API-Key") !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
```

```typescript
// Hono — return to short-circuit; await next() to continue
import { createMiddleware } from "hono/factory";

const requireApiKey = createMiddleware(async (c, next) => {
  if (c.req.header("X-API-Key") !== c.env.API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});
```

**Passing data between middleware and handler** replaces Express's habit of bolting properties onto `req` (`req.user = ...`). Hono has typed per-request storage via `c.set()` / `c.get()`:

```javascript
// Express — untyped mutation of req
app.use((req, res, next) => {
  req.user = decodeToken(req.get("Authorization"));
  next();
});
app.get("/me", (req, res) => res.json(req.user));
```

```typescript
// Hono — typed context variables
type Variables = { user: { id: string; role: string } };
const app = new Hono<{ Variables: Variables }>();

app.use("*", async (c, next) => {
  c.set("user", decodeToken(c.req.header("Authorization")));
  await next();
});
app.get("/me", (c) => c.json(c.get("user")));  // c.get("user") is fully typed
```

Declaring `Variables` once gives every `c.get("user")` call compile-time type safety — the kind of thing that was `req.user as any` in an Express codebase.

## Error Handling

Express signals errors by calling `next(err)`, which routes to a special four-argument middleware that you must register *last*. Hono centralizes this in `app.onError()`, and any error **thrown** from a handler or middleware — sync or async — lands there automatically. No more wrapping every async handler in try/catch just to forward to `next(err)`.

```javascript
// Express — must catch async errors and forward; handler registered last
app.get("/users/:id", async (req, res, next) => {
  try {
    const user = await db.findUser(req.params.id);
    if (!user) return next(createError(404, "Not found"));
    res.json(user);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message });
});
```

```typescript
// Hono — throw freely; one onError handler serializes everything
import { HTTPException } from "hono/http-exception";

app.get("/users/:id", async (c) => {
  const user = await db.findUser(c.req.param("id"));
  if (!user) throw new HTTPException(404, { message: "Not found" });
  return c.json(user);  // a thrown error from db.findUser also reaches onError
});

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});
```

Nerva ships a far more complete version of this out of the box: typed error classes (`NotFoundError`, `ConflictError`, `UnauthorizedError`, …), a single `errorHandler` that serializes `AppError`, `ZodError`, and `HTTPException` into one consistent envelope, and an `app.notFound()` handler so even unmatched routes return that same shape. That is the direct upgrade from Express's "every endpoint invents its own error JSON" problem — read the full design in the [error handling guide](../api-development/error-handling.md).

Hono's `app.notFound()` replaces the trailing catch-all `app.use()` you would add at the bottom of an Express app:

```javascript
// Express — a final middleware with no path catches everything unmatched
app.use((req, res) => res.status(404).json({ error: "Route not found" }));
```

```typescript
// Hono — a dedicated hook, order-independent
app.notFound((c) => c.json({ error: "Route not found" }, 404));
```

## Route Grouping

Express groups routes with `express.Router()` and mounts the router with `app.use()`. Hono groups them with a fresh `new Hono()` instance and mounts it with `app.route()` — same idea, and Nerva organizes every resource this way (one file per resource under `api/src/routes/`).

```javascript
// Express — routes/users.js
const router = express.Router();
router.get("/", listUsers);
router.get("/:id", getUser);
router.post("/", createUser);
module.exports = router;

// app.js
app.use("/api/v1/users", require("./routes/users"));
```

```typescript
// Hono — api/src/routes/users.ts
import { Hono } from "hono";

export const usersRoutes = new Hono()
  .get("/", listUsers)
  .get("/:id", getUser)
  .post("/", createUser);

// api/src/app.ts
app.route("/api/v1/users", usersRoutes);
```

Router-scoped middleware carries over too. Where Express does `router.use(authMiddleware)`, a Hono sub-app does `.use("/*", authMiddleware)` before its routes — so you can protect an entire resource group in one line:

```typescript
export const adminRoutes = new Hono()
  .use("/*", requireRole("admin"))   // applies to every route below
  .get("/users", listAllUsers)
  .delete("/users/:id", deleteUser);
```

## Static Files

Express serves a directory with the built-in `express.static`. Hono has `serveStatic`, imported from the runtime adapter you are targeting.

```javascript
// Express
app.use(express.static("public"));
app.use("/assets", express.static("public"));
```

```typescript
// Hono — Node.js target
import { serveStatic } from "@hono/node-server/serve-static";

app.use("/*", serveStatic({ root: "./public" }));
app.use("/assets/*", serveStatic({ root: "./public" }));
```

The import path is what changes per runtime — `@hono/node-server/serve-static` on Node, `hono/deno` or `hono/bun` on those runtimes. **On Cloudflare Workers, do not serve static assets through the app at all.** Workers has native static-asset hosting that runs before your Worker code and is billed differently; configure it in `wrangler.toml` with an `[assets]` binding rather than a `serveStatic` middleware. This is one of the few places the runtime genuinely dictates the approach.

In practice, most Nerva projects are pure JSON APIs and serve no static files — the asset side belongs to the frontend (often an [Aurelius](../../README.md#part-of-the-pmds-framework-series) app deployed separately). Reach for `serveStatic` only when an API must also hand out files.

## Environment Variables and Config

This is the section to read twice, because it is the one real portability trap.

On **Node.js**, `process.env` works exactly as it does in Express. On **Cloudflare Workers, there is no `process.env`** — environment values arrive as *bindings* on the request context, `c.env`. Code that reaches for `process.env` at module load time works on Node and silently breaks on Workers.

```javascript
// Express — process.env everywhere, usually loaded via dotenv
require("dotenv").config();
const dbUrl = process.env.DATABASE_URL;
```

```typescript
// Hono on Node — process.env still works
const dbUrl = process.env.DATABASE_URL;

// Hono on Cloudflare Workers — env comes from the context, per request
app.get("/", (c) => {
  const dbUrl = c.env.DATABASE_URL;  // typed via the Bindings generic
  // ...
});
```

Rather than scatter either form across the codebase, Nerva centralizes configuration into a single Zod-validated module — this is a strict upgrade over Express's "read `process.env.WHATEVER` wherever you need it and hope it's set." The app fails fast at startup with a clear message if a required variable is missing or malformed, instead of throwing `undefined is not a function` on the first request that needs it.

On the **Node** target, config is parsed once at boot:

```typescript
// api/src/config.ts (Node target)
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof envSchema>;
export const config: Config = envSchema.parse(process.env);  // throws on bad/missing env
```

On the **Cloudflare** target the same schema is parsed per request from `c.env` (Workers has no process to parse it into once at boot) and stashed on the context, so handlers read `c.var.config` everywhere and never touch `c.env` directly:

```typescript
// api/src/index.ts (Cloudflare target)
app.use("*", async (c, next) => {
  c.set("config", parseConfig(c.env));  // validate the bindings on the way in
  await next();
});

app.get("/", (c) => c.json({ version: c.var.config.APP_VERSION }));
```

Either way, the rest of your code imports a typed, validated `config`/`c.var.config` object — never a raw, possibly-`undefined` `process.env.FOO`. The [quickstart](../onboarding/quickstart.md) walks through filling in the generated `.env` for local development.

## Porting Gotchas Checklist

The short list of things that actually bite when porting an Express handler:

- **Forgot the `return`.** `c.json(x)` without `return` does nothing. This is the number-one bug.
- **`req.body` is now `await c.req.json()`.** It is async, and it can only be read once per request.
- **`(req, res, next)` is now `(c, next)`**, and you `await next()`.
- **`process.env` is Node-only.** On Workers it is `c.env`. Funnel everything through the Zod config module and the difference disappears.
- **No `res.send()` polymorphism.** Pick the helper that matches the type: `c.json`, `c.text`, `c.html`, `c.body`.
- **Set headers before returning the body.** `c.header(...)` mutates; the body helper produces the final `Response`.
- **Errors are thrown, not `next(err)`-ed.** Let them propagate to `app.onError()`.

## What Nerva Adds on Top of Hono

Everything above gets you to a plain Hono app — already a better foundation than Express for typed, multi-runtime APIs. Nerva is the layer that turns that foundation into a full development workflow. If you are coming from "Express plus a folder of conventions I copy between projects," this is the part that replaces the folder.

- **A 10-phase schema-to-API pipeline.** Point `/build-from-schema` at an OpenAPI spec and Nerva generates the Drizzle database schema, failing integration tests (TDD is a hard gate — tests exist before handlers), the Hono route handlers that make them pass, auth and validation middleware, contract and load tests, OpenAPI docs, and deployment config. The Express equivalent is wiring all of that by hand, every project. See the [pipeline guide](../schema-to-api/README.md).
- **24 specialized agents.** Task-focused AI agents — `backend-architect`, `schema-architect`, `auth-guardian`, `api-tester`, `migration-engineer`, `devops-automator`, and more — that Claude Code invokes automatically based on what you are doing. Full catalog in the [agents guide](../../.claude/CUSTOM-AGENTS-GUIDE.md).
- **12 development skills.** Reusable, automated workflows for the recurring jobs: JWT/OAuth2/RBAC authentication, Zod validation, Drizzle migrations with rollback safety, OpenAPI documentation, performance profiling, and security hardening. Listed in the [project README](../../README.md#12-development-skills).
- **Production-grade templates and conventions.** The error envelope, request-id propagation, security headers, graceful shutdown, health checks, and connection pooling shown throughout this guide are not snippets you assemble — they are what the generator emits. Five deployment targets (Cloudflare Workers, Node.js/Docker, AWS Lambda, Railway, Fly.io) come from one config change. See the [API development standards](../api-development/README.md).

In Express terms: Hono replaces Express, and Nerva replaces the boilerplate, the test harness, the deployment scripts, and the team conventions doc you would otherwise maintain by hand.

## Further Reading

- [ADR-001: Hono over Express](../adr/001-hono-over-express.md) — why Nerva chose Hono, with the trade-offs spelled out
- [API Development Standards](../api-development/README.md) — the TypeScript, Hono, Drizzle, and testing conventions generated code follows
- [Error Handling](../api-development/error-handling.md) — the typed-error and `app.onError()` system that replaces Express error middleware
- [CORS Configuration](../api-development/cors-configuration.md) — `hono/cors` setups for each environment, the direct counterpart to the `cors` npm package
- [Schema-to-API Pipeline](../schema-to-api/README.md) — the 10-phase generator that builds a full API from an OpenAPI spec
- [Quickstart](../onboarding/quickstart.md) — get a generated Nerva API running locally
- [Hono documentation](https://hono.dev) — the framework's own reference
- [Hono: HTTPException](https://hono.dev/docs/api/exception) — the error type Hono's built-in middleware throws
- [Express documentation](https://expressjs.com) — for cross-checking the patterns you are migrating from
