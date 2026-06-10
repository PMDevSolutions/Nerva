# CORS Configuration

How to configure Cross-Origin Resource Sharing (CORS) for Nerva APIs -- from the permissive defaults that make local development easy to the explicit allowlists production requires, plus how to debug the errors browsers report along the way.

## What CORS Is

Browsers enforce the same-origin policy: JavaScript on a page may only read responses from the page's own origin (scheme + host + port). CORS is the protocol a server uses to tell browsers which *other* origins may read its responses. When your frontend at `https://app.example.com` calls your API at `https://api.example.com`, the API must opt in by returning `Access-Control-Allow-Origin` headers, or the browser blocks the frontend from reading the response.

Two facts prevent most CORS confusion:

- **CORS is enforced by browsers, not servers.** `curl`, Postman, and server-to-server calls ignore it entirely. If a request works in Postman but fails in the browser, that points to CORS.
- **CORS is not authentication.** It controls which websites may read responses through a user's browser. Your API still needs auth middleware -- a permissive CORS policy does not "open" your API, and a strict one does not protect it.

For requests a plain HTML form could not produce -- the `Authorization` or `X-API-Key` header, a JSON body, methods like `PUT`, `PATCH`, or `DELETE` -- the browser first sends an `OPTIONS` "preflight" request asking permission. Simple `GET` requests skip preflight, which is why an API can appear to work for reads and fail only on writes.

## How Hono's `cors()` Middleware Works

Import the middleware from `hono/cors`. It behaves identically on Node.js and Cloudflare Workers:

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

app.use("*", cors());
```

The middleware does two things:

1. **Adds `Access-Control-*` headers** to every response on the paths it covers.
2. **Answers preflights itself.** `OPTIONS` requests get a `204 No Content` response with the allow headers, and never reach your route handlers.

### Options Reference

| Option | Type | Default | Response header |
|--------|------|---------|-----------------|
| `origin` | `string \| string[] \| function` | `"*"` | `Access-Control-Allow-Origin` |
| `allowMethods` | `string[]` | `["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"]` | `Access-Control-Allow-Methods` |
| `allowHeaders` | `string[]` | `[]` (mirrors the headers the preflight asks for) | `Access-Control-Allow-Headers` |
| `exposeHeaders` | `string[]` | `[]` | `Access-Control-Expose-Headers` |
| `credentials` | `boolean` | `false` | `Access-Control-Allow-Credentials` |
| `maxAge` | `number` (seconds) | unset | `Access-Control-Max-Age` |

When `origin` is an array or a function, the middleware echoes the matching origin back in `Access-Control-Allow-Origin` and adds `Vary: Origin` so caches store per-origin responses correctly. When the origin does not match, the header is omitted and the browser blocks the response.

`exposeHeaders` controls which response headers client JavaScript may read beyond the safelisted basics. Expose rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`) so frontends can back off before hitting 429s.

### Middleware Order

Register `cors()` before auth and rate limiting. Preflights never carry an `Authorization` header, so if auth middleware runs first, every preflight fails with a 401 and the browser reports it as a CORS error:

```typescript
app.use("*", cors({ origin: allowedOrigins })); // 1. CORS first
app.use("*", rateLimiter({ max: 100, window: "1m" })); // 2. Rate limiting
app.use("/api/v1/*", authMiddleware); // 3. Auth after CORS
```

Also register it on a path at least as broad as your routes. A `cors()` mounted on `/api/*` does nothing for a route mounted at `/auth/login`.

### Defaults in Nerva Projects

The starter templates (`templates/snippets/`) ship with a bare `app.use("*", cors())` -- wildcard origin, suitable for development. The schema-to-api pipeline generates CORS middleware in Phase 4 from the `security.cors` block of `.claude/pipeline.config.json`:

```json
"cors": {
  "enabled": true,
  "origins": ["*"],
  "methods": ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  "allowHeaders": ["Content-Type", "Authorization", "X-API-Key"],
  "maxAge": 86400
}
```

`origins: ["*"]` is a development default. Edit this block before running `/build-from-schema` to bake your real origins into the generated middleware, or override the origins at runtime with an environment variable as shown below.

## Development Configuration

For local development the wildcard default is fine -- any localhost port, tool, or teammate's machine can call the API without ceremony:

```typescript
import { cors } from "hono/cors";

// Defaults to Access-Control-Allow-Origin: *
app.use("*", cors());
```

The one thing a wildcard cannot do is credentials. If you are testing cookie-based auth locally, browsers reject `*` combined with credentials, so list your dev origins explicitly:

```typescript
app.use(
  "*",
  cors({
    origin: ["http://localhost:3000", "http://localhost:5173", "http://localhost:8787"],
    credentials: true,
  })
);
```

Ports are part of the origin: a frontend on `http://localhost:5173` is a different origin from `http://localhost:3000`, so list each one you use.

## Production Configuration

Never deploy with `origin: "*"`. A wildcard lets any website on the internet read your API's responses through its visitors' browsers. Production gets an explicit allowlist, driven by an environment variable so the same build runs in staging and production:

```typescript
// api/src/middleware/cors-config.ts
import { cors } from "hono/cors";

// ALLOWED_ORIGINS="https://app.example.com,https://admin.example.com"
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

export const corsConfig = cors({
  origin: allowedOrigins,
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  exposeHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-Request-Id"],
  maxAge: 86400,
});
```

Origins in the allowlist must match what the browser sends in the `Origin` header *exactly*: scheme, host, and port, with no trailing slash and no path. `https://app.example.com/` (trailing slash), `http://app.example.com` (wrong scheme), and `https://www.app.example.com` (different host) all fail to match `https://app.example.com`.

When the allowlist is not a fixed set -- per-customer subdomains, preview deployments -- pass a function instead. Return the origin to allow it, or `null` to reject:

```typescript
export const corsConfig = cors({
  origin: (origin) => {
    if (allowedOrigins.includes(origin)) return origin;
    if (origin.endsWith(".example.com") && origin.startsWith("https://")) return origin;
    return null; // No header set -- browser blocks the response
  },
  allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  maxAge: 86400,
});
```

Keep suffix checks anchored with a leading dot (`.example.com`, not `example.com`) -- otherwise `https://evilexample.com` slips through.

To switch configurations by environment on Node.js:

```typescript
const isProduction = process.env.NODE_ENV === "production";

app.use("*", isProduction ? corsConfig : cors());
```

On Cloudflare Workers, environment variables arrive per-request rather than at module scope -- see [Cloudflare Workers Considerations](#cloudflare-workers-considerations) for the equivalent pattern.

## Credentials Mode

By default, cross-origin requests carry no cookies. If your API uses cookie- or session-based auth, both sides must opt in.

Server side, set `credentials: true`, which sends `Access-Control-Allow-Credentials: true`:

```typescript
app.use(
  "*",
  cors({
    origin: ["https://app.example.com"], // Must be explicit -- browsers reject "*" with credentials
    credentials: true,
  })
);
```

Client side, the frontend must ask for credentials explicitly:

```typescript
const res = await fetch("https://api.example.com/api/v1/todos", {
  credentials: "include",
});
```

Rules that apply in credentials mode:

- `Access-Control-Allow-Origin` must echo the exact origin. Browsers reject `*` when credentials are included, no exceptions.
- Cross-site cookies need `SameSite=None; Secure` set on the cookie itself, which also means HTTPS everywhere.
- Wildcards stop working elsewhere too: with credentials, browsers treat `*` in `Access-Control-Allow-Headers` as the literal header name, not a wildcard. List headers explicitly.

If your API uses bearer tokens in the `Authorization` header (Nerva's default JWT strategy), leave `credentials` off. The token travels as a header, not a cookie, so credentials mode adds attack surface without adding anything you need.

## Preflight Caching

`maxAge` sets `Access-Control-Max-Age`, which tells the browser how long (in seconds) to cache a preflight result. While cached, repeat requests to the same endpoint skip the `OPTIONS` round-trip entirely -- on a chatty API this removes meaningful latency:

```typescript
app.use(
  "*",
  cors({
    origin: allowedOrigins,
    maxAge: 86400, // Cache preflight results for 24 hours
  })
);
```

What to know about the cache:

- It is keyed per origin + URL. A long `maxAge` does not eliminate preflights across your API -- each endpoint preflights once.
- Browsers cap the value: Chromium-based browsers honor at most 7200 (2 hours); Firefox honors up to 86400 (24 hours). Asking for more is harmless -- the browser clamps it.
- Without the header, browsers cache preflights for only 5 seconds.
- The pipeline default (`maxAge: 86400`) is right for stable production configs.

The cache cuts both ways: while you are *changing* CORS configuration, cached preflight results keep serving the old policy. If a CORS fix seems to have no effect, tick "Disable cache" in the browser's Network tab before concluding the fix failed.

## Common CORS Errors and How to Debug Them

Before reading console errors, open the browser's **Network tab** and find the failing request and its preflight. The single most misleading thing about CORS errors: **any response without CORS headers reports as a CORS error, including 500s, crashes, and platform error pages.** A "CORS error" is often a server error wearing a disguise -- check the actual status code first.

### "No 'Access-Control-Allow-Origin' header is present on the requested resource"

The response had no CORS headers at all. Usual causes:

- The `cors()` middleware is not registered, or is mounted on a narrower path than the route being called.
- The origin was rejected by your allowlist (array/function form omits the header on no-match) -- compare the request's `Origin` header against the allowlist character by character.
- The response never went through your middleware: the process crashed, or the platform returned its own error page (see the Workers section).

### "The 'Access-Control-Allow-Origin' header has a value that is not equal to the supplied origin"

The server echoed *an* origin, just not this one. Almost always an exact-match failure: `http` vs `https`, a missing or extra port, `www.` vs apex domain, or a trailing slash in the configured value.

### "The value of the 'Access-Control-Allow-Origin' header must not be the wildcard '*' when the request's credentials mode is 'include'"

The client sent `credentials: "include"` but the server is configured with the wildcard origin. Replace `*` with an explicit origin list and set `credentials: true` -- see [Credentials Mode](#credentials-mode).

### "Request header field x-api-key is not allowed by Access-Control-Allow-Headers in preflight response"

The preflight asked permission for a header your config does not list. Add it:

```typescript
cors({ allowHeaders: ["Content-Type", "Authorization", "X-API-Key"] });
```

Note this only bites when `allowHeaders` is set: a bare `cors()` mirrors whatever headers the preflight requests, so the error appears for the first time when you tighten configuration.

### "Method PATCH is not allowed by Access-Control-Allow-Methods in preflight response"

Same story for methods -- add the missing method to `allowMethods`. Hono's default set already includes `PATCH`; this usually means a custom `allowMethods` list left it out.

### "Response to preflight request doesn't pass access control check: It does not have HTTP ok status"

The `OPTIONS` request itself returned an error or a redirect:

- **401/403** -- auth or rate-limiting middleware ran before `cors()`. Reorder so CORS is first.
- **301/302** -- preflights must not redirect. Common culprits: HTTP-to-HTTPS redirects and trailing-slash rewrites. Point the frontend at the final URL.
- **404** -- the `cors()` middleware path does not cover the requested path, so no preflight handler existed.

### "The 'Access-Control-Allow-Origin' header contains multiple values"

CORS headers are being added at two layers -- typically a reverse proxy or CDN rule *and* the Hono middleware, or `cors()` registered twice. Configure CORS in exactly one place.

### Reproducing Preflights with curl

The Network tab shows what happened; `curl` lets you test fixes without a frontend. Simulate the preflight:

```bash
curl -i -X OPTIONS https://api.example.com/api/v1/todos \
  -H "Origin: https://app.example.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type,authorization"
```

A healthy preflight response looks like:

```
HTTP/2 204
access-control-allow-origin: https://app.example.com
access-control-allow-methods: GET,POST,PUT,PATCH,DELETE,OPTIONS
access-control-allow-headers: Content-Type,Authorization,X-API-Key
access-control-max-age: 86400
vary: Origin
```

Then test the actual request:

```bash
curl -i https://api.example.com/api/v1/todos -H "Origin: https://app.example.com"
```

Remember `curl` does not enforce CORS -- it just shows you the headers. If `curl` shows the right headers but the browser still blocks, the browser is sending a different `Origin` than you tested (check the Network tab), or a cached preflight is still serving the old policy.

## Cloudflare Workers Considerations

Hono's `cors()` works unchanged on Workers, and nothing at the Cloudflare layer adds CORS headers for you. The platform differences worth knowing:

### Environment Variables Arrive Per-Request

Workers deliver configuration through bindings on `c.env`, not `process.env` at module scope. To drive origins from `wrangler.toml`, build the middleware inside a wrapper:

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";

type Bindings = {
  ALLOWED_ORIGINS: string; // Comma-separated, from wrangler.toml [vars]
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", (c, next) => {
  const corsMiddleware = cors({
    origin: c.env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()),
    allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    maxAge: 86400,
  });
  return corsMiddleware(c, next);
});
```

Set the variable per environment in `wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGINS = "http://localhost:3000,http://localhost:5173"

[env.staging.vars]
ALLOWED_ORIGINS = "https://staging.app.example.com"

[env.production.vars]
ALLOWED_ORIGINS = "https://app.example.com"
```

Deploy with `npx wrangler deploy --env production` and the production allowlist applies.

### Uncaught Exceptions Look Like CORS Errors

When a Worker throws an uncaught exception, Cloudflare returns its own error page -- which has no CORS headers, so the browser reports a CORS failure instead of the real error. If production suddenly "has CORS errors" on one endpoint, stream the logs before touching CORS config:

```bash
npx wrangler tail
```

### Pages Preview Deployments

Cloudflare Pages gives every preview deployment its own subdomain (`<hash>.my-app.pages.dev`), so a fixed allowlist cannot cover them. Use the function form with an anchored suffix check:

```typescript
origin: (origin) => {
  if (origin === "https://app.example.com") return origin;
  if (origin.endsWith(".my-app.pages.dev")) return origin; // Preview deployments
  return null;
},
```

The leading dot matters: `.my-app.pages.dev` matches only subdomains of your own Pages project.

### Edge Caching and Per-Origin Headers

With an allowlist, responses carry the *requesting* origin in `Access-Control-Allow-Origin`. If you cache API responses at the edge (the Cache API or `cf` fetch options), a response stored for one origin can be served to another with the wrong header. Either skip edge caching for allowlisted endpoints, include the origin in the cache key, or cache only responses that carry no per-origin headers.

### Cloudflare Access in Front of the API

Cloudflare Access authenticates requests before they reach your Worker, and preflights carry no credentials -- so Access blocks them and every cross-origin request fails. If your API sits behind Access, enable the Access application setting that bypasses `OPTIONS` requests to the origin, and let the Worker's `cors()` middleware answer them.

## Further Reading

- [MDN: Cross-Origin Resource Sharing](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) -- the full protocol, header by header
- [Hono CORS middleware](https://hono.dev/docs/middleware/builtin/cors) -- upstream middleware documentation
- [Security Standards](./README.md#security-standards) -- the rest of Nerva's security conventions
