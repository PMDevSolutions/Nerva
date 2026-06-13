# Migrating from Fastify to Nerva (Hono)

A side-by-side guide for Fastify developers moving to Nerva. Of all the Node.js frameworks, Fastify is the closest in spirit to Hono — both are schema-first, both are TypeScript-first, both are built for performance, and both let an `async` handler simply *return* its result. So this is less a rewrite than a re-spelling: most of what you already do has a direct Hono equivalent, with one substantive swap (JSON Schema → Zod) and one collapse (`request`/`reply` → a single `c`).

The reason to make the move is the one thing Fastify structurally cannot do: run unchanged on the edge. [ADR-001](../adr/001-hono-over-express.md) records Nerva's framework choice and evaluates Fastify directly — *"Strong TypeScript support and good performance on Node.js. However, it is Node.js-only and cannot run on Cloudflare Workers."* Hono is built on Web Standards (`Request`/`Response`) instead of Node's `http` module, so the same handler runs on Workers, Deno, and Bun as well as Node. Migrating keeps the schema-first, typed workflow you already like and opens the edge as a deployment target.

If you're weighing *whether* to switch rather than *how*, read that ADR first. This guide is about the how.

## Where Fastify and Hono Already Agree

Start here, because it's most of the story. These are not patterns you have to relearn — they carry straight over:

- **Schema-first validation.** Fastify validates requests against a schema before your handler runs (Ajv over JSON Schema); Nerva does the same with Zod via `@hono/zod-validator`. In both, invalid input is rejected with a 400 before your code sees it, and the handler only ever receives validated data.
- **Types flow from the schema.** Fastify's TypeBox type provider infers `request.body`'s type from the schema; Zod does it natively with `z.infer`. Same payoff — one schema, no hand-written request interfaces — and Zod needs no `withTypeProvider` step to get there.
- **Handlers return their result.** A Fastify `async` handler can `return payload` and the framework sends it. A Hono handler does the same, wrapped in a response helper: `return c.json(payload)`. You already think in returns, not in `res`-style callbacks.
- **Composition over a kitchen sink.** Fastify keeps the core small and adds capability through plugins; Hono does the same with middleware and mountable sub-apps. Both reward small, focused units wired together.
- **Test without a live server.** `fastify.inject({ method, url })` becomes `app.request("/path")` — both dispatch a request straight to the app in-process, with no port to bind. Your test structure barely changes.

The headline difference is the upside: because Hono speaks Web Standards rather than Node internals, **the same handler runs on Cloudflare Workers, Deno, and Bun in addition to Node** — exactly the portability ADR-001 cites as the reason Fastify, for all its strengths on Node, didn't fit Nerva's edge-first target.

## The Three Real Differences

Almost all the friction comes down to three shifts. Internalize these and the rest is table lookup.

1. **One context `c`, not `(request, reply)`.** Fastify hands you two objects; Hono hands you one. Request data lives under `c.req` (`c.req.param()`, `c.req.query()`, `c.req.header()`), and you build responses with helpers on `c` (`c.json()`, `c.text()`, `c.header()`). There is no separate `reply`.

2. **Validation is Zod, not JSON Schema.** Instead of attaching a `schema` object of JSON Schema to the route options, you attach a `zValidator(...)` middleware built from a Zod schema. The mental model is identical — declare the shape, get validated and typed data — but the dialect is TypeScript code, not a JSON Schema literal.

3. **Serialization is explicit; there's no automatic response filter.** This is the one that can bite. Fastify's `response` schema runs your payload through fast-json-stringify, which both speeds up serialization and *strips any property the schema doesn't declare* — a built-in guard against leaking fields like `passwordHash`. Hono's `c.json()` serializes the object exactly as given; nothing is stripped for you. You decide what goes in the response (and Nerva's dev/test response validation catches leaks — see [Serialization and Response](#serialization-and-response)).

Everything else is mechanical translation.

## Cheat Sheet

The quick reference. Each row is expanded with context and caveats in the sections that follow.

| Concern | Fastify | Hono (Nerva) |
|---------|---------|--------------|
| Create app | `Fastify()` | `new Hono()` |
| Start server (Node) | `app.listen({ port: 3000 })` | `serve({ fetch: app.fetch, port: 3000 })` |
| Run on the edge | not supported (Node-only) | `export default app` (Workers) |
| Define route | `app.get("/u", handler)` | `app.get("/u", handler)` |
| Route + schema | `app.post("/u", { schema }, h)` | `app.post("/u", zValidator("json", s), h)` |
| Path param | `request.params.id` | `c.req.param("id")` |
| Query value | `request.query.q` | `c.req.query("q")` |
| Header | `request.headers["x-foo"]` | `c.req.header("X-Foo")` |
| Validated body | `request.body` | `c.req.valid("json")` |
| Unvalidated body | `request.body` | `await c.req.json()` |
| Send JSON | `return payload` / `reply.send(p)` | `return c.json(p)` |
| JSON + status | `reply.code(201).send(x)` | `return c.json(x, 201)` |
| Set header | `reply.header("X-Foo", "bar")` | `c.header("X-Foo", "bar")` |
| Redirect | `reply.redirect("/login")` | `return c.redirect("/login")` |
| Validation engine | Ajv (JSON Schema) | Zod (`@hono/zod-validator`) |
| Type inference | `withTypeProvider<…>()` + TypeBox | `z.infer` (built in) |
| Response filtering | `response` schema (fast-json-stringify) | shape the payload / response validation (dev/test) |
| Group routes | `app.register(plugin, { prefix })` | `app.route(prefix, subApp)` |
| Scoped middleware | encapsulated plugin | `subApp.use("*", mw)` |
| App-wide middleware | `fastify-plugin` (`fp`) | `app.use("*", mw)` |
| Per-request data | `decorateRequest` + `request.x` | `c.set("x", …)` / `c.get("x")` |
| App-wide service | `decorate("db", db)` → `fastify.db` | shared import / `c.var` (Workers) |
| Before-handler hook | `addHook("preHandler", fn)` | middleware before the handler |
| After-response hook | `addHook("onResponse", fn)` | middleware after `await next()` |
| Error handler | `setErrorHandler(fn)` | `app.onError(fn)` |
| 404 handler | `setNotFoundHandler(fn)` | `app.notFound(fn)` |
| Throw HTTP error | `fastify.httpErrors.notFound()` | `throw new HTTPException(404)` |
| CORS | `@fastify/cors` | `cors()` (`hono/cors`, built in) |
| Security headers | `@fastify/helmet` | `secureHeaders()` (built in) |
| Logging | `Fastify({ logger: true })` (pino) | `logger()` (`hono/logger`) |
| Env validation | `@fastify/env` (JSON Schema) | Zod config module |
| In-process test | `app.inject({ method, url })` | `app.request("/path")` |

## App Setup and Plugin Registration

Fastify builds the app, registers plugins (asynchronously, with order and encapsulation that matter), and awaits readiness before listening:

```javascript
// Fastify
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { usersRoutes } from "./routes/users.js";

const app = Fastify({ logger: true }); // pino logger built in

await app.register(cors);              // @fastify/cors
await app.register(helmet);            // @fastify/helmet
await app.register(usersRoutes, { prefix: "/api/v1/users" });

await app.listen({ port: 3000 });
```

Hono is the same shape, with three differences: the common middleware come from `hono/*` (no separate npm install), registration is synchronous, and `app.use()` takes a path pattern as its first argument — use `"*"` to match everything. This is the actual setup Nerva generates for the Node target:

```typescript
// Hono (Nerva — Node target, api/src/index.ts)
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { usersRoutes } from "./routes/users";

const app = new Hono();

app.use("*", logger());        // Fastify({ logger: true })
app.use("*", cors());          // @fastify/cors
app.use("*", compress());      // @fastify/compress
app.use("*", etag());          // @fastify/etag
app.use("*", secureHeaders()); // @fastify/helmet
app.use("*", requestId());     // adds a request id to every request

app.route("/api/v1/users", usersRoutes);

serve({ fetch: app.fetch, port: 3000 });
```

Two things stand out coming from Fastify:

- **`cors()`, `secureHeaders()`, `compress()`, and `etag()` are built into Hono's core** (`hono/*`). Their Fastify counterparts (`@fastify/cors`, `@fastify/helmet`, `@fastify/compress`, `@fastify/etag`) are separate installs; here they're imports.
- **There's no plugin tree and no `await app.ready()`.** Hono wires middleware synchronously in declaration order. You give up Fastify's automatic encapsulation, but you gain a simpler model — middleware applies to the path you give it, full stop. Recovering scoped behavior is covered under [Plugins and Encapsulation](#plugins-and-encapsulation).

`app.register(plugin, { prefix })` has a direct counterpart, `app.route(prefix, subApp)`, also covered below.

## Route Registration

Fastify defines routes with method shorthands or the full `route` object, attaching the schema through the options:

```javascript
// Fastify — method shorthand, with a schema in the options object
app.get("/users", listUsers);
app.post("/users", { schema: createUserSchema }, createUser);

// Fastify — the full route-object form
app.route({
  method: "GET",
  url: "/users/:id",
  schema: getUserSchema,
  handler: getUser,
});
```

Hono uses the same method names and the same `:param` path syntax. The schema rides along as `zValidator(...)` middleware instead of a `schema` option:

```typescript
// Hono — same methods; the schema is a validator in the chain
app.get("/users", listUsers);
app.post("/users", zValidator("json", createUserSchema), createUser);
app.get("/users/:id", zValidator("param", getUserParams), getUser);
```

Path parameters use the identical `:param` syntax. Hono also supports optional params (`/users/:id?`), regex constraints (`/users/:id{[0-9]+}`), and wildcards (`/files/*`).

Nerva keeps a resource's routes in one **chained** expression — the idiomatic Hono shape, which also preserves end-to-end type inference for the generated RPC client:

```typescript
// Hono (Nerva) — api/src/routes/users.ts
export const usersRoutes = new Hono()
  .get("/", zValidator("query", listQuery), listUsers)
  .get("/:id", zValidator("param", idParam), getUser)
  .post("/", zValidator("json", createUserSchema), createUser)
  .put("/:id", zValidator("param", idParam), zValidator("json", updateUserSchema), updateUser)
  .delete("/:id", zValidator("param", idParam), deleteUser);
```

Each route can carry more than one validator — one per request part (`json`, `query`, `param`, `header`) — where Fastify bundles every part into a single `schema` object keyed by `body`/`querystring`/`params`/`headers`.

## Request Schemas and Validation

This is the substantive swap: JSON Schema becomes Zod. The structure maps almost field for field.

A Fastify body schema:

```javascript
// Fastify — JSON Schema (validated by Ajv)
const createUserSchema = {
  body: {
    type: "object",
    required: ["email", "name"],
    additionalProperties: false,
    properties: {
      email: { type: "string", format: "email" },
      name: { type: "string", minLength: 1, maxLength: 255 },
      role: { type: "string", enum: ["user", "admin"], default: "user" },
      age: { type: "integer", minimum: 0 },
    },
  },
};
```

The Zod equivalent — which doubles as the TypeScript type, something the JSON Schema cannot do on its own:

```typescript
// Hono (Nerva) — Zod (validated by @hono/zod-validator)
import { z } from "zod";

export const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
  role: z.enum(["user", "admin"]).default("user"),
  age: z.number().int().min(0).optional(),
});

export type CreateUser = z.infer<typeof createUserSchema>;
```

A few translation notes:

- **`required: [...]` is implicit.** In Zod every key is required unless you mark it `.optional()` (or give it a `.default()`). The `required` array disappears.
- **`additionalProperties: false` is roughly Zod's default.** `z.object()` *strips* unknown keys on parse, so unexpected fields are dropped rather than rejected. To get Fastify's reject-unknowns behavior, use `.strict()`.
- **`format` / `minLength` / `enum` / `minimum` → `.email()` / `.min()` / `.enum()` / `.min()`.** The vocabulary changes; the constraints are the same.

Validated data reaches the handler synchronously, exactly as `request.body` does in Fastify — only the accessor changes:

```javascript
// Fastify — request.body is validated and typed (via the type provider)
app.post("/users", { schema: createUserSchema }, async (request, reply) => {
  const { email, name } = request.body;
  reply.code(201);
  return await createUser({ email, name });
});
```

```typescript
// Hono (Nerva) — c.req.valid("json") is validated and typed
app.post("/", zValidator("json", createUserSchema), async (c) => {
  const { email, name } = c.req.valid("json");
  return c.json(await createUser({ email, name }), 201);
});
```

`c.req.valid("json")` is the key alignment: like `request.body`, it is already parsed and validated, so you never call `await c.req.json()` yourself on a validated route. (Reach for `await c.req.json()` only on a route with no validator.) Query and path params work the same way: `c.req.valid("query")`, `c.req.valid("param")`.

When validation fails, both frameworks short-circuit with a 400 before the handler runs. Fastify returns its `{ statusCode, error, message }` shape; Nerva formats the Zod issues into its standard error envelope (see [Error Handling](#error-handling)).

## Serialization and Response

Read this section twice — it's the one place a Fastify habit can quietly cause a bug.

In Fastify, the `response` schema does two jobs at once. It serializes via fast-json-stringify (faster than `JSON.stringify`), and — because the baseline Ajv config sets `removeAdditional` — it **strips any property your schema doesn't list**. That's why a Fastify handler can `return` a whole database row and trust that `passwordHash` never reaches the client, as long as the response schema omits it:

```javascript
// Fastify — the response schema drops undeclared fields (passwordHash never leaks)
app.get("/users/:id", {
  schema: {
    response: {
      200: {
        type: "object",
        properties: {
          id: { type: "string" },
          email: { type: "string" },
          name: { type: "string" },
          // passwordHash is intentionally absent → fast-json-stringify drops it
        },
      },
    },
  },
}, async (request) => {
  return await db.getUserById(request.params.id); // full row, including passwordHash
});
```

Hono's `c.json()` has **no equivalent automatic filter** — it serializes the object exactly as handed to it. The same code ported naively would leak `passwordHash`. So in Nerva you decide what's in the response explicitly, two ways that work together:

```typescript
// Hono (Nerva) — shape the response yourself
app.get("/:id", zValidator("param", idParam), async (c) => {
  const user = await getUserById(c.req.valid("param").id);
  // Select only safe columns in the Drizzle query, or map the row to a DTO:
  return c.json({ id: user.id, email: user.email, name: user.name });
});
```

- **Shape it at the source.** Select only the columns you intend to expose in the Drizzle query, or map the row to a response object before `c.json()`. This is the durable habit.
- **Let response validation catch mistakes.** Nerva validates each response against the endpoint's Zod response schema during development and test runs. Because `z.object().parse()` drops unknown keys, an accidental extra field fails a test instead of shipping — the closest analog to Fastify's `removeAdditional`, applied as a dev/test guard rather than a production serializer.

The net trade: you give up Fastify's "filtering for free" and gain explicit control (and one fewer place where a schema and a query silently disagree). The status and header API also moves onto `c`:

```javascript
// Fastify
reply.code(201).send(created);          // JSON + status
reply.header("X-Total-Count", "42");    // header
reply.redirect("/login");               // redirect
reply.code(204).send();                 // empty
```

```typescript
// Hono
return c.json(created, 201);            // JSON + status
c.header("X-Total-Count", "42");        // header (set before returning)
return c.redirect("/login");            // redirect
return c.body(null, 204);               // empty
```

The rule, as with any Hono move: set headers first with `c.header(...)`, then `return` the body helper that produces the final `Response`.

## Type Providers and Type Inference

Fastify needs a *type provider* because JSON Schema isn't TypeScript — TypeBox makes a schema and a static type from one declaration, and `withTypeProvider` wires that inference into route handlers:

```typescript
// Fastify — TypeBox type provider
import Fastify from "fastify";
import { Type, type Static, TypeBoxTypeProvider } from "@fastify/type-provider-typebox";

const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();

const CreateUser = Type.Object({
  email: Type.String({ format: "email" }),
  name: Type.String(),
});
type CreateUser = Static<typeof CreateUser>;

app.post("/users", { schema: { body: CreateUser } }, (request, reply) => {
  const { email, name } = request.body; // typed: { email: string; name: string }
});
```

Zod is TypeScript from the start, so there's no provider to install and no `withTypeProvider` step. `z.infer` gives you the type, and `zValidator` feeds the inferred type straight into the handler:

```typescript
// Hono (Nerva) — Zod, inference built in
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const createUser = z.object({
  email: z.string().email(),
  name: z.string(),
});
type CreateUser = z.infer<typeof createUser>;

app.post("/", zValidator("json", createUser), (c) => {
  const { email, name } = c.req.valid("json"); // typed: { email: string; name: string }
});
```

If you use `@fastify/type-provider-json-schema-to-ts` instead of TypeBox, the conclusion is the same: that entire category of tooling — bridging JSON Schema to TypeScript types — has no counterpart in Nerva, because Zod never leaves TypeScript in the first place. `Static<typeof X>` becomes `z.infer<typeof x>`, and the provider registration goes away.

## Plugins and Encapsulation

Fastify's plugin system does two distinct jobs, and each maps to a different Hono tool.

**Job 1 — grouping routes under a prefix.** In Fastify you `register` a plugin with a `prefix`; in Hono you mount a sub-app with `app.route()`:

```javascript
// Fastify — routes/users.js
export default async function (fastify, opts) {
  fastify.get("/", listUsers);
  fastify.get("/:id", getUser);
  fastify.post("/", createUser);
}

// app.js
app.register(usersRoutes, { prefix: "/api/v1/users" });
```

```typescript
// Hono (Nerva) — api/src/routes/users.ts
export const usersRoutes = new Hono()
  .get("/", listUsers)
  .get("/:id", getUser)
  .post("/", createUser);

// api/src/app.ts
app.route("/api/v1/users", usersRoutes);
```

**Job 2 — encapsulation.** This is Fastify's signature feature: a plugin gets its own scope, so hooks and decorators registered inside it apply only to that plugin and its children, not its siblings. Hono has no automatic encapsulation, but you reproduce the *effect* by attaching middleware to the specific sub-app that should have it:

```javascript
// Fastify — auth applies only to routes inside this encapsulated plugin
app.register(async (admin) => {
  admin.addHook("preHandler", requireAdmin); // scoped to `admin`
  admin.get("/users", listAllUsers);
  admin.delete("/users/:id", deleteUser);
}, { prefix: "/admin" });
```

```typescript
// Hono — middleware on the sub-app is the encapsulation boundary
const adminRoutes = new Hono()
  .use("*", requireAdmin)          // applies to every route below, and nowhere else
  .get("/users", listAllUsers)
  .delete("/users/:id", deleteUser);

app.route("/admin", adminRoutes);
```

When you deliberately *break* encapsulation in Fastify — wrapping a plugin in `fastify-plugin` (`fp`) so its decorators and hooks reach the whole app — the Hono equivalent is registering the middleware on the root app with a `"*"` matcher:

```javascript
// Fastify — fp() escapes encapsulation; the decorator is app-wide
import fp from "fastify-plugin";

export default fp(async (fastify) => {
  fastify.decorate("db", createDb());
});
```

```typescript
// Hono — root-level middleware (or a shared module import) is app-wide
app.use("*", async (c, next) => {
  c.set("db", db); // available to every handler
  await next();
});
```

The difference to keep in mind: Fastify decides scope by *where in the plugin tree* you register, automatically; Hono decides scope by *which app instance and path* you attach to, explicitly. Less magic, more wiring you can see.

## Decorators and Context Variables

Fastify's `decorate` family attaches things to the instance, the request, or the reply. Each has a Hono home.

**Per-request data** — `decorateRequest` plus a hook that fills it (the classic `request.user`) — becomes Hono's typed context variables:

```javascript
// Fastify — declare the decorator, populate it in a hook
fastify.decorateRequest("user", null);
fastify.addHook("preHandler", async (request) => {
  request.user = await authenticate(request.headers.authorization);
});
fastify.get("/me", async (request) => request.user);
```

```typescript
// Hono — typed Variables, set in middleware, read with c.get()
type Variables = { user: { id: string; role: string } };
const app = new Hono<{ Variables: Variables }>();

app.use("*", async (c, next) => {
  c.set("user", await authenticate(c.req.header("Authorization")));
  await next();
});
app.get("/me", (c) => c.json(c.get("user"))); // c.get("user") is fully typed
```

Declaring `decorateRequest("user", null)` up front in Fastify (recommended, so V8 can keep the request shape stable) corresponds to declaring the `Variables` generic once — except Hono's version is enforced by the type checker, turning what was often `request.user as any` into a compile-time guarantee.

**App-wide services** — `fastify.decorate("db", db)` exposing `fastify.db` everywhere — have two idiomatic Hono forms, depending on target. On Node, import the shared module directly. On Cloudflare Workers, where resources arrive per request as bindings, set it on the context in middleware and read it from `c.var`:

```javascript
// Fastify — instance decorator
fastify.decorate("db", db);
app.get("/users", async () => fastify.db.query.users.findMany());
```

```typescript
// Hono — Node: a shared import; Workers: c.var set from bindings
import { db } from "../db"; // Node target
app.get("/users", (c) => c.json(db.query.users.findMany()));

// Workers target: c.set("db", drizzle(c.env.DB)) in middleware, then read c.var.db
```

`decorateReply` has no direct analog and rarely needs one — anything you'd hang on the reply in Fastify, you either set as a header (`c.header`) or compute at response time in Hono.

## Hooks and the Middleware Chain

Fastify exposes the request lifecycle as a series of named hooks; Hono exposes it as a single middleware function split by `await next()`. The same logic that needs *two* Fastify hooks — one for "before", one for "after" — is one Hono middleware:

```javascript
// Fastify — timing spans two hooks
fastify.addHook("onRequest", async (request) => {
  request.startTime = Date.now();
});
fastify.addHook("onResponse", async (request, reply) => {
  request.log.info(`${request.method} ${request.url} ${Date.now() - request.startTime}ms`);
});
```

```typescript
// Hono — before and after in one function, divided by await next()
import { createMiddleware } from "hono/factory";

const timing = createMiddleware(async (c, next) => {
  const start = Date.now();
  await next();                    // everything above this runs before the handler
  const ms = Date.now() - start;   // everything below runs once the handler responded
  console.log(`${c.req.method} ${c.req.path} ${ms}ms`);
});

app.use("*", timing);
```

Position in the chain replaces the hook name. Code that ran in `onRequest` goes at the top of an early-registered middleware; code that ran in `onResponse` goes after `await next()`. Here's how the lifecycle maps:

| Fastify hook | Fires | Hono equivalent |
|--------------|-------|-----------------|
| `onRequest` | before body parsing | middleware before `await next()`, registered early |
| `preParsing` | before the body is parsed | logic before you read the body (rarely needed) |
| `preValidation` | before schema validation | middleware ordered *before* the `zValidator` |
| `preHandler` | after validation, before the handler | middleware ordered *after* the `zValidator` (e.g. auth) |
| `preSerialization` | transform the payload before send | shape the object before `c.json()`, or edit `c.res` after `await next()` |
| `onSend` | modify the outgoing response | middleware after `await next()`, mutating `c.res` |
| `onResponse` | after the response is sent | middleware after `await next()` |
| `onError` | when an error is thrown | `app.onError()` (see below) |
| `onTimeout` / `onRequestAbort` | request timed out / client aborted | runtime concern (e.g. Workers CPU limits, `c.req.raw.signal`) |
| app `onReady` | server about to accept traffic | top-level setup code before `serve()` |
| app `onClose` / `preClose` | server shutting down | a graceful-shutdown handler around `serve()` (Node) |
| app `onRoute` / `onRegister` | a route/plugin was registered | no analog — Hono has no plugin tree to introspect |

The most common hook in practice, `preHandler` for authentication, is simply middleware ordered after validation:

```javascript
// Fastify — preHandler guard
fastify.addHook("preHandler", async (request, reply) => {
  if (!request.user) {
    reply.code(401);
    throw new Error("Unauthorized");
  }
});
```

```typescript
// Hono — same guard, as middleware; return to short-circuit
app.use("/admin/*", async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Unauthorized" }, 401);
  await next();
});
```

Note the short-circuit: where Fastify throws or sends from inside a hook to stop the request, Hono middleware just `return`s a response and never calls `await next()`. There is no `next()` you must remember *not* to call.

## Error Handling

Both frameworks centralize error formatting in one place — Fastify's `setErrorHandler`, Hono's `app.onError` — and in both, an error thrown from a handler or middleware lands there automatically. The translation is nearly mechanical:

```javascript
// Fastify
fastify.setErrorHandler((error, request, reply) => {
  reply.status(error.statusCode ?? 500).send({ error: error.message });
});
fastify.setNotFoundHandler((request, reply) => {
  reply.status(404).send({ error: "Not found" });
});

// throwing a typed HTTP error (with @fastify/sensible)
throw fastify.httpErrors.notFound("User not found");
```

```typescript
// Hono
import { HTTPException } from "hono/http-exception";

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});
app.notFound((c) => c.json({ error: "Route not found" }, 404));

// throwing a typed HTTP error
throw new HTTPException(404, { message: "User not found" });
```

`setErrorHandler` → `app.onError`, `setNotFoundHandler` → `app.notFound`, and `fastify.httpErrors.notFound()` (or any error carrying a `statusCode`) → `throw new HTTPException(404, ...)`. Validation failures are handled for you in both: Fastify's Ajv error and Nerva's `ZodError` each get serialized by the central handler rather than by each route.

Nerva ships a more complete version than the snippet above: typed error classes (`NotFoundError`, `ConflictError`, `UnauthorizedError`, …) and a single `errorHandler` that serializes `AppError`, `ZodError`, and `HTTPException` into one consistent envelope, plus an `app.notFound()` that returns that same shape. If you reached for `@fastify/sensible` to get `httpErrors`, this is the built-in upgrade — the full design is in the [error handling guide](../api-development/error-handling.md).

## Configuration and Environment

If you validate configuration with `@fastify/env` — itself a JSON Schema over `process.env` — you'll feel at home: Nerva does the same with a Zod schema, failing fast at startup with a clear message when a variable is missing or malformed.

```javascript
// Fastify — @fastify/env (JSON Schema over process.env)
await app.register(fastifyEnv, {
  schema: {
    type: "object",
    required: ["DATABASE_URL"],
    properties: {
      PORT: { type: "number", default: 3000 },
      DATABASE_URL: { type: "string" },
    },
  },
});
```

```typescript
// Hono (Nerva) — api/src/config.ts (Node target)
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
});

export const config = envSchema.parse(process.env); // throws on bad/missing env
```

The one genuinely new wrinkle is the edge: **Cloudflare Workers has no `process.env`.** Environment values arrive as bindings on the request context, `c.env`, so on the Workers target the same schema is parsed per request from `c.env` and stashed on the context (`c.var.config`) rather than parsed once at boot. Code that reads `process.env` at module load works on Node and silently breaks on Workers — funnel everything through the config module and the difference stays in one file. The [quickstart](../onboarding/quickstart.md) walks through filling in the generated `.env`.

## Porting Gotchas Checklist

The short list of things that actually bite when porting a Fastify route:

- **No automatic response filtering.** Fastify's `response` schema strips undeclared fields; `c.json()` does not. Return only what should be exposed.
- **`(request, reply)` is now `(c, next)` for middleware and `(c)` for handlers.** Request data is under `c.req`; there is no `reply`.
- **`request.body` is `c.req.valid("json")`** on a validated route (synchronous, like Fastify) — or `await c.req.json()` on a route with no validator.
- **`return payload` becomes `return c.json(payload)`.** You still return, but you wrap it in a response helper — and never drop the `return`.
- **`reply.code(201).send(x)` is `return c.json(x, 201)`.** Status is the second argument, not a chained call.
- **Set headers before returning the body.** `c.header(...)` mutates; the body helper produces the final `Response`.
- **`process.env` is Node-only.** On Workers it's `c.env`. The Zod config module hides the difference.
- **Errors are thrown, not handled per-route.** Let them propagate to `app.onError()`; throw `HTTPException` for typed HTTP errors.

## What Nerva Adds on Top of Hono

Everything above gets you to a plain Hono app — already a better fit than Fastify for typed APIs that must also run on the edge. Nerva is the layer that turns that into a full workflow. If you're coming from "Fastify plus a folder of plugins and conventions I copy between projects," this is the part that replaces the folder.

- **A 10-phase schema-to-API pipeline.** Point `/build-from-schema` at an OpenAPI spec and Nerva generates the Drizzle database schema, failing integration tests (TDD is a hard gate — tests exist before handlers), the Hono route handlers that make them pass, auth and validation middleware, contract and load tests, OpenAPI docs, and deployment config. See the [pipeline guide](../schema-to-api/README.md).
- **24 specialized agents.** Task-focused AI agents — `backend-architect`, `schema-architect`, `auth-guardian`, `api-tester`, `migration-engineer`, `devops-automator`, and more — that Claude Code invokes automatically based on what you're doing. Full catalog in the [agents guide](../../.claude/CUSTOM-AGENTS-GUIDE.md).
- **12 development skills.** Reusable, automated workflows for the recurring jobs: JWT/OAuth2/RBAC authentication, Zod validation, Drizzle migrations with rollback safety, OpenAPI documentation, performance profiling, and security hardening. Listed in the [project README](../../README.md#12-development-skills).
- **Production-grade templates and conventions.** The error envelope, request-id propagation, security headers, graceful shutdown, health checks, and connection pooling shown throughout this guide are what the generator emits, not snippets you assemble. Five deployment targets (Cloudflare Workers, Node.js/Docker, AWS Lambda, Railway, Fly.io) come from one config change — including Cloudflare Workers, the edge runtime Fastify can't reach. See the [API development standards](../api-development/README.md).

In Fastify terms: Hono replaces the framework, and Nerva replaces the plugin stack, the test harness, the deployment config, and the conventions doc you'd otherwise maintain by hand.

## Further Reading

- [ADR-001: Hono over Express](../adr/001-hono-over-express.md) — Nerva's framework choice, with Fastify evaluated directly (the source of the "Node.js-only" trade-off)
- [API Development Standards](../api-development/README.md) — the TypeScript, Hono, Drizzle, and testing conventions generated code follows
- [Error Handling](../api-development/error-handling.md) — the typed-error and `app.onError()` system that replaces `setErrorHandler` plus `@fastify/sensible`
- [CORS Configuration](../api-development/cors-configuration.md) — `hono/cors` setups for each environment, the counterpart to `@fastify/cors`
- [Schema-to-API Pipeline](../schema-to-api/README.md) — the 10-phase generator that builds a full API from an OpenAPI spec
- [Quickstart](../onboarding/quickstart.md) — get a generated Nerva API running locally
- [Hono documentation](https://hono.dev) — the framework's own reference
- [Hono: HTTPException](https://hono.dev/docs/api/exception) — the error type Hono's built-in middleware throws
- [Zod documentation](https://zod.dev) — the validation library that replaces JSON Schema and TypeBox
- [Fastify: Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) — for cross-checking the schema behavior you're migrating from
- [Fastify: Hooks](https://fastify.dev/docs/latest/Reference/Hooks/) — the lifecycle hooks mapped above
- [Fastify: Type Providers](https://fastify.dev/docs/latest/Reference/Type-Providers/) — TypeBox and json-schema-to-ts, the inference layer Zod replaces
