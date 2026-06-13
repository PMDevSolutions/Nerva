# API Versioning

How to version a Nerva API and evolve it without breaking consumers -- the four strategies and their trade-offs, how to implement each in Hono, the deprecation and sunset headers that warn clients before a version disappears, which changes force a new version, and a checklist for shipping one.

Versioning is one of the most debated topics in API design, but the goal is narrow: change the API over time without breaking the code already calling it. The cheapest version bump is the one you avoid by making changes additively. When a change genuinely can't be additive, a version boundary lets old and new clients coexist while consumers migrate on their own schedule. Nerva picks an opinionated default and configures it in one place; this guide covers that default, the alternatives, and how to evolve safely whichever you choose.

## Nerva's Default: URL Prefix

The default strategy lives in the `api.versioning` block of [`.claude/pipeline.config.json`](../../.claude/pipeline.config.json):

```json
"versioning": {
  "strategy": "url-prefix",
  "currentVersion": "v1",
  "deprecationHeaderEnabled": true
}
```

This puts the version in the path -- `GET /api/v1/users` -- with the prefix driven by `routes.prefix` (`/api/v1`). The pipeline generates routes under that prefix, and the health check reports the running version (`api.healthCheck.includeVersion`), so `GET /health` tells you which version is live.

URL-prefix is the default because it is the most visible option. The version shows up in server logs, in `curl`, in browser history, and in cache keys, so "which version did that client call?" never requires guessing. It needs no special client configuration, and routing on a path prefix is trivial. The cost is that the version rides along in every path and you version the API as a whole rather than per resource -- acceptable trade-offs for most APIs, and the reason most public APIs settle here.

### API Version vs. Release Version

Keep two numbers separate. The **API version** (`v1`) is the contract: the shapes and behavior consumers depend on. The **release version** (a semver like `1.4.2`, surfaced as `APP_VERSION` at `/` and `/health`) is the deployed build. You ship many releases inside one API version -- bug fixes and additive features bump the release, not the contract. Only a breaking change bumps `v1` to `v2`.

## The Four Strategies

| Strategy | Looks like | Strengths | Weaknesses |
|----------|-----------|-----------|------------|
| **URL prefix** (default) | `GET /api/v1/users` | Visible in logs, `curl`, and caches; trivial to route; no client setup | Version in every path; whole-API granularity |
| **Custom header** | `X-API-Version: 2` | Clean URLs; per-request selection | Invisible in a browser; easy to forget; needs `Vary` for caches |
| **Content negotiation** | `Accept: application/vnd.nerva.v2+json` | Standards-based; one URL per resource | Verbose; hard to test by hand; needs `Vary: Accept` |
| **Query parameter** | `GET /users?version=2` | Easy to try in a browser | Pollutes URLs and cache keys; collides with real params; easy to drop |

The strategies are not mutually exclusive -- an API can accept a header and fall back to a default -- but pick one as the contract and document it. Mixing them silently is how a client ends up on a version nobody intended.

## Implementing Each in Hono

The examples assume the `AppEnv` type from the [error handling guide](./error-handling.md), extended with an `apiVersion` context variable where a strategy needs one.

### URL Prefix

Mount each version as its own sub-app. Running versions side by side is then just two `route()` calls:

```typescript
// api/src/app.ts
import { Hono } from "hono";
import { todosRoutes } from "./routes/todos";
import { usersRoutes } from "./routes/users";

const v1 = new Hono<AppEnv>();
v1.route("/todos", todosRoutes);
v1.route("/users", usersRoutes);

const app = new Hono<AppEnv>();
app.route("/api/v1", v1);
```

When a `v2` arrives, re-implement only what changed and reuse the rest -- a v2 sub-app can mount v1's unchanged route groups directly:

```typescript
const v2 = new Hono<AppEnv>();
v2.route("/todos", todosRoutesV2); // changed in v2
v2.route("/users", usersRoutes);   // identical to v1 -- reuse the handler

app.route("/api/v1", v1);
app.route("/api/v2", v2);
```

For a single active version, `basePath` is terser and applies the prefix to every route at once:

```typescript
const app = new Hono<AppEnv>().basePath("/api/v1");
app.route("/todos", todosRoutes);
app.route("/users", usersRoutes);
```

### Custom Header

Resolve the version in middleware, default to the current one, and store it on the context for handlers to read:

```typescript
// api/src/middleware/version.ts
import { createMiddleware } from "hono/factory";

const SUPPORTED = new Set(["v1", "v2"]);
const CURRENT = "v1";

export const apiVersion = createMiddleware<AppEnv>(async (c, next) => {
  const raw = c.req.header("X-API-Version") ?? CURRENT;
  const version = raw.startsWith("v") ? raw : `v${raw}`;
  c.set("apiVersion", SUPPORTED.has(version) ? version : CURRENT);
  c.header("Vary", "X-API-Version"); // caches must key on the header
  await next();
});
```

A handler then shapes its response by `c.get("apiVersion")`. The URL stays clean, but the version is invisible to anyone reading a log line or a browser address bar, and any cache in front of the API must `Vary` on the header or it will serve one version's body to a client asking for another.

### Content Negotiation

Content negotiation is the formal version of the header approach: the client asks for a versioned media type in `Accept`, and the server replies with that type. Use a vendor media type -- `application/vnd.nerva.v2+json` -- so the version travels with the representation:

```typescript
// api/src/middleware/version.ts
import { createMiddleware } from "hono/factory";

export const negotiateVersion = createMiddleware<AppEnv>(async (c, next) => {
  const accept = c.req.header("Accept") ?? "";
  const match = accept.match(/application\/vnd\.nerva\.v(\d+)\+json/);
  c.set("apiVersion", match ? `v${match[1]}` : "v1");
  c.header("Vary", "Accept");
  await next();
});
```

This is the most standards-aligned option and keeps one URL per resource, which some REST purists prefer. It is also the most verbose and the hardest to exercise by hand -- every test and `curl` must set the right `Accept` header, and the same `Vary: Accept` caching rule applies. See the [CORS guide](./cors-configuration.md) for exposing custom headers to browser clients.

### Query Parameter

The simplest to type and the easiest to misuse:

```typescript
const version = c.req.query("version") ?? "1";
```

A `?version=2` is trivial to try in a browser, but it pollutes every URL, competes with real query parameters, leaks into cache keys inconsistently, and is the easiest to forget -- a dropped parameter silently routes to the default version. Reach for it only for quick internal tools, not a public contract.

## Deprecation and Sunset Headers

A version rarely disappears at once; it is announced, deprecated, and finally removed. Two standard response headers carry that timeline, controlled by `deprecationHeaderEnabled` in `api.versioning`:

- **`Deprecation`** ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745)) -- the endpoint is deprecated. The common form is `Deprecation: true`; the RFC also allows a date to announce a deprecation that takes effect in the future.
- **`Sunset`** ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)) -- an HTTP date after which the endpoint may stop responding.
- **`Link`** -- `rel="successor-version"` points at the replacement, and `rel="deprecation"` points at the migration docs.

A middleware stamps them onto a deprecated route group:

```typescript
// api/src/middleware/deprecation.ts
import { createMiddleware } from "hono/factory";

export function deprecated(options: { sunset: string; successor: string }) {
  return createMiddleware(async (c, next) => {
    await next();
    c.header("Deprecation", "true"); // RFC 9745
    c.header("Sunset", options.sunset); // RFC 8594 -- an HTTP date
    c.header("Link", `<${options.successor}>; rel="successor-version"`);
  });
}
```

```typescript
// Mark all of v1's todos as deprecated, sunsetting at a fixed date
v1.use(
  "/todos/*",
  deprecated({
    sunset: "Wed, 31 Dec 2025 23:59:59 GMT",
    successor: "/api/v2/todos",
  }),
);
```

These headers are how a well-behaved client learns to migrate without a human reading a changelog: monitoring can alert on any `Deprecation` header in a response, and the `Sunset` date gives a hard deadline. Set the date once you have a successor and a migration path, not before.

## Breaking vs. Non-Breaking Changes

The version question reduces to a single test: would this change break code that works today? If not, ship it in the current version. If so, it needs a new one.

**Non-breaking -- ship in the current version:**

- Add a new endpoint or resource
- Add a new *optional* request field or query parameter
- Add a new field to a response body
- Add a new error `code` for a new failure mode (the [error envelope](./error-handling.md) is itself additive)
- Loosen validation to accept input you previously rejected
- Add a value to a response enum, *only if* clients are documented to tolerate unknown values

**Breaking -- requires a new version:**

- Remove or rename a field, endpoint, or query parameter
- Change a field's type or format (`string` to `number`, a different date format)
- Make an optional request field required, or add a new required field
- Tighten validation to reject input you previously accepted
- Change a response status code, or the meaning of an existing error `code`
- Change a default -- page size, sort order, or filter behavior
- Restructure the response envelope or change nesting
- Add or change an authentication or authorization requirement
- Remove a value a response enum used to return

The dividing line is the *tolerant reader* principle: design servers to add fields additively and clients to ignore fields they don't recognize. An API and its consumers that both follow it turn most evolution into non-breaking changes, and a new version becomes a rare event rather than a quarterly chore.

## Migration Checklist for a Version Bump

When a change is genuinely breaking, work through these in order:

1. **Confirm it is breaking.** Check the table above. If the change is additive, stop here and ship it in the current version -- do not create a version for a change that doesn't need one.
2. **Stand up the new version's route tree.** Add `/api/v2` as its own sub-app and leave `/api/v1` untouched. Both serve traffic during the transition.
3. **Reuse, don't copy.** Re-implement only the handlers and services whose behavior changed; mount the unchanged route groups from v1. Copying the whole API doubles the surface you maintain.
4. **Update the spec and regenerate.** Add the v2 paths to the OpenAPI spec, then regenerate the types and client with `./scripts/generate-client.sh` so consumers get typed access to v2.
5. **Deprecate v1.** With `deprecationHeaderEnabled` on, attach `Deprecation`, `Sunset`, and `Link` headers to v1, pick a sunset date, and announce it in the changelog and to known consumers.
6. **Keep both contracts tested.** Leave v1's contract tests green and add v2's. Both versions are supported until the sunset date.
7. **Watch the traffic.** Log the requested version on every request so you can see v1 usage decline toward zero.
8. **Remove v1 after sunset.** Once the date has passed and traffic is negligible, delete v1's routes, services, tests, and spec paths in one cleanup.

## Further Reading

- [Hono: Routing](https://hono.dev/docs/api/routing) -- route grouping and mounting sub-apps
- [Hono: App and `basePath`](https://hono.dev/docs/api/hono) -- prefixing every route at once
- [RFC 8594: The Sunset HTTP Header Field](https://www.rfc-editor.org/rfc/rfc8594) -- announcing when a resource stops responding
- [RFC 9745: The Deprecation HTTP Header Field](https://www.rfc-editor.org/rfc/rfc9745) -- announcing that a resource is deprecated
- [`.claude/pipeline.config.json`](../../.claude/pipeline.config.json) -- the `api.versioning` block this guide configures
- [Error Handling](./error-handling.md) -- why adding an error `code` is non-breaking
- [API Development Standards](./README.md) -- the conventions this guide extends
