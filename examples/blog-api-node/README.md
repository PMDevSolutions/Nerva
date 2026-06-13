# Blog API — Node.js / Docker Example

A complete, working blog API built with [Nerva](../../README.md) for the **Node.js / Docker** deployment target. Where the [Todo API example](../todo-api-cloudflare/) shows the edge path (Cloudflare Workers + D1), this example covers the traditional server path and the features a realistic API needs beyond basic CRUD:

- **Related resources** — users → posts → comments with Drizzle relations, cascading deletes, and embedded authors in responses
- **JWT authentication** — register, login, and refresh-token rotation (`jose`, HS256, issuer/audience validation), passwords hashed with Node's built-in scrypt
- **Pagination** — offset-based `?limit=&offset=` with a `meta` envelope on every list endpoint
- **PostgreSQL + Drizzle** — schema as the single source of truth, committed SQL migrations
- **Zod validation** — every body, query, and path param validated, with structured error details
- **Docker orchestration** — one `docker compose up` builds the image, starts PostgreSQL, applies migrations, and health-checks the API

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Compose v2 (`docker compose`)
- [pnpm](https://pnpm.io/installation) and Node.js 22+ — only needed for local development and running the tests

## Quick start

```bash
cd examples/blog-api-node/api

docker compose up -d --build                            # postgres → migrations → API
docker compose run --rm migrate node dist/db/seed.js    # optional: demo users + posts

curl http://localhost:3000/health
```

The compose file starts three services: `postgres` (PostgreSQL 17), `migrate` (a one-shot job that applies the committed Drizzle migrations, then exits), and `api` (started only after migrations complete, gated by a `/health` check). The migrate job runs the compiled migration runner ([`api/src/db/migrate.ts`](api/src/db/migrate.ts)) inside the same production image as the API — `drizzle-orm` ships the migrator as a runtime dependency, so the pruned image needs no dev tooling.

The seed creates two accounts you can log in with immediately:

| Email | Password |
|-------|----------|
| `alice@example.com` | `password123` |
| `bob@example.com` | `password123` |

Tear down with `docker compose down` (add `-v` to also drop the database volume).

> Ports busy? Override them: `DB_PORT=5433 PORT=3001 docker compose up -d --build`. The API is pinned to the pnpm release in `package.json` (`packageManager`), so the Docker build resolves dependencies exactly like the committed lockfile.

## API at a glance

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Service + database status |
| POST | `/auth/register` | — | Create an account, returns user + token pair |
| POST | `/auth/login` | — | Exchange credentials for a token pair |
| POST | `/auth/refresh` | — | Exchange a refresh token for a new pair |
| GET | `/auth/me` | Bearer | The caller's own profile (includes email) |
| GET | `/users/:id` | — | Public profile (no email) |
| GET | `/users/:id/posts` | — | A user's posts, paginated |
| GET | `/posts` | — | All posts with author, newest first, paginated |
| GET | `/posts/:id` | — | One post with author |
| POST | `/posts` | Bearer | Create a post |
| PATCH | `/posts/:id` | Bearer (author) | Partial update (title and/or content) |
| DELETE | `/posts/:id` | Bearer (author) | Delete a post (comments cascade) |
| GET | `/posts/:id/comments` | — | Comments on a post, oldest first, paginated |
| POST | `/posts/:id/comments` | Bearer | Comment on a post |
| DELETE | `/comments/:id` | Bearer (author) | Delete own comment |

## Example requests

Register and capture the tokens:

```bash
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"carol@example.com","name":"Carol","password":"password123"}'
```

```json
{
  "data": {
    "user": {
      "id": "5f0c…",
      "email": "carol@example.com",
      "name": "Carol",
      "createdAt": "2026-06-13T01:00:00.000Z"
    },
    "accessToken": "eyJhbGci…",
    "refreshToken": "eyJhbGci…"
  }
}
```

Create a post (access tokens expire after 15 minutes; refresh tokens after 7 days):

```bash
TOKEN="eyJhbGci…"   # accessToken from register/login
curl -s -X POST http://localhost:3000/posts \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Hello","content":"My first post."}'
```

List posts with pagination — every list response carries a `meta` block:

```bash
curl -s 'http://localhost:3000/posts?limit=2&offset=0'
```

```json
{
  "data": [
    {
      "id": "9a31…",
      "title": "Hello",
      "content": "My first post.",
      "author": { "id": "5f0c…", "name": "Carol" },
      "createdAt": "2026-06-13T01:01:00.000Z",
      "updatedAt": "2026-06-13T01:01:00.000Z",
      "authorId": "5f0c…"
    }
  ],
  "meta": { "total": 4, "limit": 2, "offset": 0 }
}
```

Comment on a post, then refresh the session when the access token expires:

```bash
curl -s -X POST http://localhost:3000/posts/9a31…/comments \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"body":"Nice post!"}'

curl -s -X POST http://localhost:3000/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"eyJhbGci…"}'
```

Errors always use the same envelope (codes: `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INTERNAL_ERROR`):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "field": "password", "message": "Too small: expected string to have >=8 characters" }]
  }
}
```

## Database schema

```
┌─────────────────────────┐
│ users                   │
│─────────────────────────│
│ id             uuid  PK │
│ email          text  UQ │
│ name           text     │
│ password_hash  text     │
│ created_at  timestamptz │
│ updated_at  timestamptz │
└───────┬───────────┬─────┘
        │ 1         │ 1
        │           └────────────────────────┐
        │ *  (author_id, cascade)            │ *  (author_id, cascade)
┌───────┴─────────────────┐          ┌───────┴─────────────────┐
│ posts                   │          │ comments                │
│─────────────────────────│          │─────────────────────────│
│ id             uuid  PK │          │ id             uuid  PK │
│ author_id      uuid  FK │ 1      * │ post_id        uuid  FK │
│ title          text     ├──────────┤ author_id      uuid  FK │
│ content        text     │ (cascade)│ body           text     │
│ created_at  timestamptz │          │ created_at  timestamptz │
│ updated_at  timestamptz │          └─────────────────────────┘
└─────────────────────────┘
```

Deleting a user removes their posts and comments; deleting a post removes its comments — enforced by `ON DELETE CASCADE` in the database, not application code. The schema lives in [`api/src/db/schema.ts`](api/src/db/schema.ts); the SQL migration generated from it is committed under [`api/src/db/migrations/`](api/src/db/migrations/).

## Local development (without the API container)

```bash
cd examples/blog-api-node/api
pnpm install
docker compose up -d postgres        # just the database
cp .env.example .env
pnpm db:migrate                      # apply migrations
pnpm db:seed                         # optional demo data
pnpm dev                             # http://localhost:3000, reloads on save
```

## Testing

```bash
pnpm test              # run once
pnpm test:watch        # watch mode
pnpm test:coverage     # enforces 80% thresholds
```

The integration tests run against **PGlite** — a real in-process PostgreSQL — so `pnpm test` needs **no Docker and no running database**. The test harness ([`api/tests/helpers.ts`](api/tests/helpers.ts)) applies the same committed migrations the compose stack uses, which means the migration SQL itself is exercised on every test run. The app is built around an injected database (`createApp(db)` in [`api/src/app.ts`](api/src/app.ts)), so production and tests run identical application code on different drivers.

56 tests cover the full auth lifecycle (register → login → refresh → protected routes, duplicate emails, tampered/expired/cross-type tokens, deleted accounts), ownership rules (403s), pagination windows and meta, validation details, cascading deletes, and the health check (healthy + degraded).

## Project structure

```
api/
├── src/
│   ├── index.ts            # Entry: real postgres-js pool + graceful shutdown
│   ├── app.ts              # createApp(db): middleware, routes, error envelope
│   ├── config.ts           # Zod-validated environment
│   ├── db/
│   │   ├── schema.ts       # users / posts / comments + relations (source of truth)
│   │   ├── client.ts       # postgres-js client factory + Database type
│   │   ├── migrations/     # Committed SQL generated by drizzle-kit
│   │   ├── migrate.ts      # Deploy-time migration runner (compose migrate service)
│   │   └── seed.ts         # Demo data (pnpm db:seed)
│   ├── lib/
│   │   ├── tokens.ts       # jose JWT sign/verify (access + refresh)
│   │   ├── password.ts     # scrypt hash/verify (no native deps)
│   │   ├── pagination.ts   # limit/offset schema + meta builder
│   │   ├── validate.ts     # zValidator wrapper with the error envelope
│   │   └── errors.ts       # apiError(c, status, code, message)
│   ├── middleware/
│   │   └── auth.ts         # requireAuth: Bearer → verified user in context
│   └── routes/             # health, auth, users, posts, comments
├── tests/
│   ├── helpers.ts          # PGlite test database + register/post factories
│   ├── unit/               # tokens, password, pagination, health
│   └── integration/        # auth flows, posts, comments (full HTTP cycles)
├── Dockerfile              # Multi-stage: build → pruned production image
└── docker-compose.yml      # api + migrate (one-shot) + postgres
```

## How this was built

The project started from the Nerva generator and kept its layout, configs, Dockerfile, and quality gates:

```bash
./scripts/setup-project.sh blog-api-node --node
```

On top of the generated starter: the schema grew two related tables, auth (jose + scrypt) and the routes were added, the entry point was refactored into an injectable `createApp(db)` factory for testability, a `migrate` one-shot service joined the compose file, and the soft-delete starter snippets were removed to keep the example focused. Everything else — strict TypeScript, ESLint/Prettier, Vitest with coverage thresholds, the multi-stage Dockerfile — is stock Nerva.
