# Schema-to-API Pipeline

Convert an OpenAPI specification into a fully working, tested API server through an automated 10-phase pipeline.

## Pipeline Overview

| Phase | Name | Description |
|-------|------|-------------|
| 1 | Schema Intake | Parse and validate the OpenAPI spec, extract models and endpoints |
| 2 | Database Design | Generate Drizzle ORM table schemas with relations and indexes |
| 3 | Migration Generation | Create timestamped SQL migration files from Drizzle schemas |
| 4 | TDD Test Writing | Write integration tests for every endpoint before implementation |
| 5 | Route Generation | Scaffold Hono route handlers matching the OpenAPI paths |
| 6 | Service Layer | Build business logic services called by route handlers |
| 7 | Validation Layer | Generate Zod schemas for request/response validation |
| 8 | Auth & Security | Wire authentication middleware, CORS, rate limiting |
| 9 | Documentation | Generate API docs, Swagger UI config, example responses |
| 10 | Deployment Config | Produce Wrangler TOML, Dockerfile, or both |

## Phase-by-Phase Deep Dive

### Phase 1: Schema Intake

**What it does:** Parses the OpenAPI YAML or JSON file, validates it against the OpenAPI 3.0/3.1 specification, and extracts a normalized model of all schemas, paths, parameters, and responses.

- **Inputs:** OpenAPI spec file (YAML or JSON)
- **Outputs:** `pipeline-state.json` with parsed models, endpoints, and dependency graph
- **Tools:** `@apidevtools/swagger-parser` for validation, custom AST walker for extraction
- **Config:** `pipeline.config.json` -- `schemaPath`, `strictValidation`

### Phase 2: Database Design

**What it does:** Converts OpenAPI component schemas into Drizzle ORM table definitions. Infers relations from `$ref` pointers and naming conventions. Adds appropriate indexes based on query patterns implied by endpoint parameters.

- **Inputs:** Parsed models from Phase 1
- **Outputs:** `api/src/db/schema/*.ts` files (one per resource)
- **Tools:** Drizzle ORM schema builder, `database-design` skill
- **Config:** `pipeline.config.json` -- `database.provider` (pg, d1), `database.naming` (snake_case)

### Phase 3: Migration Generation

**What it does:** Generates SQL migration files from the Drizzle schema diff. Each migration is timestamped and includes both up and down operations.

- **Inputs:** Drizzle schema files from Phase 2
- **Outputs:** `api/src/db/migrations/YYYYMMDD_HHMMSS_*.sql`
- **Tools:** `drizzle-kit generate`, custom rollback generator
- **Config:** `pipeline.config.json` -- `database.migrationsDir`

### Phase 4: TDD Test Writing

**What it does:** Writes integration tests for every endpoint defined in the OpenAPI spec. Tests cover success paths, validation errors, 404s, auth failures, and edge cases. This phase runs before route implementation -- the TDD gate is enforced.

- **Inputs:** Endpoint definitions from Phase 1, schemas from Phase 2
- **Outputs:** `api/tests/integration/*.test.ts` files
- **Tools:** Vitest, supertest, `tdd-from-schema` skill
- **Config:** `pipeline.config.json` -- `testing.minCoverage`, `testing.includeLoadTests`

### Phase 5: Route Generation

**What it does:** Scaffolds Hono route handlers for each OpenAPI path. Groups routes by resource using `Hono.route()`. Wires middleware chains for auth, validation, and error handling.

- **Inputs:** Endpoint definitions, test expectations from Phase 4
- **Outputs:** `api/src/routes/*.ts` files (one per resource)
- **Tools:** Hono router, `route-generation` skill
- **Config:** `pipeline.config.json` -- `routes.prefix`, `routes.versioning`

### Phase 6: Service Layer

**What it does:** Generates service classes that contain business logic. Routes delegate to services, which handle database queries, transformations, and transaction management.

- **Inputs:** Route handlers from Phase 5, Drizzle schemas from Phase 2
- **Outputs:** `api/src/services/*.ts` files
- **Tools:** Drizzle query builder, transaction helpers
- **Config:** `pipeline.config.json` -- `services.transactionIsolation`

### Phase 7: Validation Layer

**What it does:** Generates Zod schemas from Drizzle table types and OpenAPI request/response definitions. Wires `zValidator` middleware into route chains.

- **Inputs:** Drizzle schemas, OpenAPI request/response bodies
- **Outputs:** `api/src/types/validators/*.ts`, updated route middleware
- **Tools:** `drizzle-zod`, `@hono/zod-validator`, `api-validation` skill
- **Config:** `pipeline.config.json` -- `validation.stripUnknown`, `validation.coerceTypes`

### Phase 8: Auth & Security

**What it does:** Configures authentication middleware (JWT, API key, or both), role-based access control, CORS policies, rate limiting, and security headers.

- **Inputs:** OpenAPI security schemes, route definitions
- **Outputs:** `api/src/middleware/auth.ts`, `api/src/middleware/security.ts`, updated routes
- **Tools:** `hono/jwt`, custom RBAC middleware, `api-authentication` and `api-security` skills
- **Config:** `pipeline.config.json` -- `auth.strategy`, `auth.jwtSecret`, `security.rateLimit`

### Phase 9: Documentation

**What it does:** Generates enriched API documentation including Swagger UI configuration, example request/response payloads, and error code references.

- **Inputs:** Finalized routes, Zod schemas, auth configuration
- **Outputs:** `api/src/routes/docs.ts` (Swagger UI route), updated OpenAPI spec
- **Tools:** `@hono/swagger-ui`, `api-documentation` skill
- **Config:** `pipeline.config.json` -- `docs.title`, `docs.version`, `docs.servers`

### Phase 10: Deployment Config

**What it does:** Produces deployment configuration files matching the target platform. For Cloudflare Workers: `wrangler.toml` with D1 bindings. For Node.js: `Dockerfile` with multi-stage build and `docker-compose.yml`.

- **Inputs:** Project structure, database config, environment variables
- **Outputs:** `wrangler.toml` and/or `Dockerfile` + `docker-compose.yml`
- **Tools:** `deployment-config-generator` skill
- **Config:** `pipeline.config.json` -- `deployment.target` (cloudflare, node, both)

## Configuration

All pipeline behavior is controlled by `pipeline.config.json` in the project root:

```json
{
  "schemaPath": "./openapi.yaml",
  "strictValidation": true,
  "database": {
    "provider": "pg",
    "naming": "snake_case",
    "migrationsDir": "api/src/db/migrations"
  },
  "routes": {
    "prefix": "/api/v1",
    "versioning": true
  },
  "testing": {
    "minCoverage": 80,
    "includeLoadTests": false,
    "contractTestsEnabled": true
  },
  "validation": {
    "stripUnknown": true,
    "coerceTypes": true
  },
  "auth": {
    "strategy": "jwt",
    "jwtSecret": "${JWT_SECRET}"
  },
  "security": {
    "rateLimit": { "max": 100, "window": "1m" },
    "cors": { "origins": ["*"] }
  },
  "docs": {
    "title": "My API",
    "version": "1.0.0",
    "servers": [{ "url": "http://localhost:8787" }]
  },
  "deployment": {
    "target": "cloudflare"
  }
}
```

## Resuming Interrupted Builds

The pipeline writes progress to `pipeline-state.json` after each phase completes. If a build is interrupted:

```
/build-from-schema openapi-spec.yaml --resume
```

This reads the state file and resumes from the last completed phase. To force a restart from a specific phase:

```
/build-from-schema openapi-spec.yaml --from-phase 4
```

To re-run only a single phase:

```
/build-from-schema openapi-spec.yaml --only-phase 7
```

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| "Invalid OpenAPI spec" in Phase 1 | Malformed YAML or missing required fields | Run `./scripts/validate-openapi.sh spec.yaml` for detailed errors |
| Phase 4 tests fail immediately | Database not running or migrations not applied | Run `./scripts/run-migrations.sh` before re-running Phase 4 |
| "Cannot resolve $ref" | Circular or broken schema references | Split circular refs into separate schemas with explicit IDs |
| Route conflicts in Phase 5 | Duplicate paths in OpenAPI spec | Check for overlapping path patterns (e.g., `/{id}` vs `/me`) |
| Auth middleware errors in Phase 8 | Missing JWT_SECRET environment variable | Set `JWT_SECRET` in `.env` or `wrangler.toml` secrets |
| D1 binding errors | Wrangler not configured for D1 | Run `npx wrangler d1 create <db-name>` and update `wrangler.toml` |
| Docker build fails | Missing dependencies in Dockerfile | Ensure `pnpm-lock.yaml` is not in `.dockerignore` |

## Examples

### Walkthrough: Todo API

Given this OpenAPI spec (`todo-api.yaml`):

```yaml
openapi: "3.1.0"
info:
  title: Todo API
  version: "1.0.0"
paths:
  /todos:
    get:
      summary: List all todos
      responses:
        "200":
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Todo"
    post:
      summary: Create a todo
      requestBody:
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CreateTodo"
      responses:
        "201":
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Todo"
  /todos/{id}:
    get:
      summary: Get a todo by ID
    put:
      summary: Update a todo
    delete:
      summary: Delete a todo
components:
  schemas:
    Todo:
      type: object
      properties:
        id:
          type: string
          format: uuid
        title:
          type: string
        completed:
          type: boolean
        createdAt:
          type: string
          format: date-time
    CreateTodo:
      type: object
      required: [title]
      properties:
        title:
          type: string
```

Run the pipeline:

```
/build-from-schema todo-api.yaml
```

The pipeline produces:
- `api/src/db/schema/todos.ts` -- Drizzle table with `id`, `title`, `completed`, `createdAt`
- `api/src/db/migrations/20260329_120000_create_todos.sql` -- CREATE TABLE migration
- `api/tests/integration/todos.test.ts` -- Tests for GET/POST/PUT/DELETE
- `api/src/routes/todos.ts` -- Hono route handlers
- `api/src/services/todo-service.ts` -- CRUD business logic
- `api/src/types/validators/todo.ts` -- Zod schemas for validation
- Deployment config matching your target platform

All tests pass against the generated implementation, and the API matches the OpenAPI contract exactly.
