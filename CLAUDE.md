# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Claude Code-integrated API & backend development framework** providing specialized agents, skills, scripts, and schema-to-API conversion pipelines. Built with TypeScript, Hono (HTTP framework), Drizzle ORM, and PostgreSQL. Deployed to Cloudflare Workers or Node.js.

Nerva is the backend counterpart to **Aurelius** (frontend framework).

The framework is designed for:
- Schema-first API development (OpenAPI spec to working API)
- OpenAPI-to-working-API conversion with TDD-mandatory development
- Comprehensive testing (integration tests, contract tests, load tests with k6)
- Deployment to Cloudflare Workers or Node.js with Docker support
- Full product lifecycle support (engineering, database, testing, DevOps, operations)

## Project Structure

```
project-root/
├── api/                    # Generated API application
│   ├── src/
│   │   ├── routes/         # Hono route handlers
│   │   ├── db/
│   │   │   ├── schema/     # Drizzle schema files
│   │   │   └── migrations/ # Database migrations
│   │   ├── middleware/      # Auth, validation, rate limiting, CORS
│   │   ├── services/       # Business logic layer
│   │   └── types/          # Generated TypeScript types from schema
│   ├── tests/
│   │   ├── integration/    # API integration tests
│   │   ├── unit/           # Service unit tests
│   │   └── fixtures/       # Test data factories
│   └── package.json
├── scripts/                # Automation scripts
├── templates/              # Starter configs
│   ├── shared/             # ESLint, Prettier, TypeScript configs
│   ├── cloudflare-workers/ # Wrangler config
│   ├── node-server/        # Node.js server config
│   └── docker/             # Dockerfile, docker-compose
├── docs/
│   ├── schema-to-api/      # Pipeline guide
│   └── api-development/    # Development standards
├── .claude/
│   ├── agents/             # 24 specialized agents
│   ├── skills/             # 12 API development skills
│   ├── commands/           # Slash commands
│   ├── pipeline.config.json
│   ├── CUSTOM-AGENTS-GUIDE.md
│   └── PLUGINS-REFERENCE.md
├── CLAUDE.md               # This file
└── README.md
```

## Development Scripts

```bash
# Setup a new API project
./scripts/setup-project.sh my-api --cloudflare  # or --node

# Run tests with coverage
./scripts/run-tests.sh

# TypeScript type checking
./scripts/check-types.sh

# Security audit
./scripts/security-scan.sh

# Generate database migration
./scripts/generate-migration.sh

# Seed database with test data
./scripts/seed-database.sh

# Run load tests
./scripts/load-test.sh

# Generate OpenAPI documentation
./scripts/generate-openapi-docs.sh

# Generate typed API client (for Aurelius frontends)
./scripts/generate-client.sh
```

## Development Commands

### Package Management (always use pnpm)
```bash
pnpm install              # Install dependencies
pnpm add <package>        # Add a dependency
pnpm add -D <package>     # Add a dev dependency
pnpm update               # Update dependencies
```

### Development Server
```bash
# Hono dev server (Node.js target)
pnpm dev                  # Start dev server (port 3000)
pnpm build                # Production build
pnpm start                # Start production server

# Cloudflare Workers target
npx wrangler dev           # Start local Workers dev server (port 8787)
npx wrangler deploy        # Deploy to Cloudflare Workers
npx wrangler tail           # Stream live logs from Workers
```

### Testing
```bash
pnpm vitest               # Run tests in watch mode
pnpm vitest run           # Run tests once
pnpm vitest run --coverage # Run with coverage report
```

### Code Quality
```bash
pnpm eslint .             # Run ESLint
pnpm eslint . --fix       # Auto-fix ESLint issues
pnpm prettier --check .   # Check formatting
pnpm prettier --write .   # Fix formatting
pnpm tsc --noEmit         # Type check without emitting
```

### Database
```bash
pnpm drizzle-kit generate  # Generate migration from schema changes
pnpm drizzle-kit push      # Push schema changes directly (dev only)
pnpm drizzle-kit migrate   # Run pending migrations
pnpm drizzle-kit studio    # Open Drizzle Studio (database GUI)
```
---

## Claude Code Architecture & Configuration

### Installed Plugins (5 Total)

- **episodic-memory** - Conversation search and memory
- **commit-commands** - Git workflow automation
- **superpowers** - Advanced development workflows
- **ai-taskmaster** - Task management (local)

**Note:** GitHub integration via `gh` CLI

**Full documentation:** `.claude/PLUGINS-REFERENCE.md`

---

### Custom Agents (24 Total)

24 specialized agents covering the full API development lifecycle:

| Category | Count | Key Agents |
|----------|-------|------------|
| Engineering | 6 | backend-architect, rapid-prototyper, test-writer-fixer, error-boundary-architect, performance-benchmarker, infrastructure-maintainer |
| Schema & Database | 3 | schema-architect, migration-engineer, data-seeder |
| API Development | 3 | endpoint-generator, auth-guardian, openapi-documenter |
| Testing & QA | 2 | api-tester, performance-benchmarker |
| DevOps | 2 | devops-automator, infrastructure-maintainer |
| Product | 3 | sprint-prioritizer, feedback-synthesizer, project-shipper |
| Operations | 3 | analytics-reporter, legal-compliance-checker, studio-producer |
| Content & Docs | 2 | content-creator, brand-guardian |
| Meta | 2 | joker, studio-coach |

Agents are invoked automatically based on task context.

**Full catalog:** `.claude/CUSTOM-AGENTS-GUIDE.md`

---

### Skills (12 Total)

**Pipeline Skills:**

| Skill | Purpose | Triggers |
|-------|---------|----------|
| schema-intake | OpenAPI parsing + build-spec.json generation | "parse OpenAPI", "create API spec" |
| database-design | Drizzle schema generation from API spec | Phase 1 of /build-from-schema |
| tdd-from-schema | Write failing integration tests before route handlers | Phase 2 of /build-from-schema |
| route-generation | Generate Hono handlers that pass the tests | Phase 3 of /build-from-schema |
| api-testing-verification | Run integration + contract + load tests | Phase 5 of /build-from-schema |
| deployment-config-generator | Docker, wrangler.toml, CI/CD generation | Phase 8 of /build-from-schema |

**API Development Skills:**

| Skill | Purpose | Triggers |
|-------|---------|----------|
| api-authentication | JWT, OAuth2, API keys, RBAC patterns for Hono | "auth", "JWT", "OAuth" |
| api-validation | Zod schemas, request/response validation middleware | "validation", "Zod" |
| database-migrations | Drizzle migration generation, rollback safety | "migration", "schema change" |
| api-documentation | OpenAPI 3.1 spec generation, Postman export | "document API", "OpenAPI" |
| api-performance | Query optimization, caching, connection pooling | "performance", "optimize" |
| api-security | Input sanitization, SQL injection prevention, rate limiting | "security", "rate limit" |

**Full catalog:** `.claude/skills/README.md`

---
### Schema-to-API Pipeline

**Single command:** `/build-from-schema openapi-spec.yaml`

Autonomous 10-phase pipeline that converts an OpenAPI specification into a working, tested, deployable API:

```
/build-from-schema openapi-spec.yaml

  [0] SCHEMA INTAKE  → Parse OpenAPI spec → build-spec.json
  [1] DATABASE DESIGN → Drizzle schema + initial migration
  [2] TDD GATE (HARD) → Failing integration tests for every endpoint (RED)
  [3] ROUTE GENERATION → Hono handlers + middleware that pass tests (GREEN)
  [4] AUTH & MIDDLEWARE → JWT/OAuth2, rate limiting, CORS, Zod validation
  [5] API TESTING → Integration tests, contract tests, load tests
  [6] DOCUMENTATION → OpenAPI docs, README, Postman collection
  [7] QUALITY GATE → Type check + coverage + security audit + bundle analysis
  [8] DEPLOYMENT CONFIG → Dockerfile, docker-compose, wrangler.toml, CI/CD
  [9] REPORT → Build report with endpoint inventory, test results, schema diagram
```

**Key artifacts:**
- `build-spec.json` — Machine-readable build plan with endpoints, schemas, auth requirements
- `api/src/db/schema/` — Drizzle ORM schema files (single source of truth for database)
- `api/src/routes/` — Hono route handlers with typed request/response
- `api/src/middleware/` — Auth, validation, rate limiting, CORS middleware
- `api/src/services/` — Business logic layer (decoupled from HTTP layer)
- `api/tests/integration/` — Full integration test suite for every endpoint
- `api/tests/fixtures/` — Test data factories and seed data
- `pipeline.config.json` — Thresholds, iteration limits, deployment targets

**Features:**
- **TDD mandatory** — tests must exist before route handlers, hard gate blocks build phase
- **Schema-first** — OpenAPI spec drives database schema, types, handlers, and tests
- **Contract testing** — generated tests validate API responses against OpenAPI spec
- **Load testing** — k6 scripts generated for performance-critical endpoints
- **Multi-target deployment** — Cloudflare Workers, Node.js, Docker with single config change
- **Type safety end-to-end** — Drizzle schema to Zod validators to TypeScript types
- Quality gate: 80%+ coverage, TypeScript strict, security audit, bundle analysis
- Resumable: TodoWrite tracks progress across interrupted sessions
- **Aurelius integration** — generates typed API client for frontend consumption
- **Database migration safety** — rollback scripts generated for every migration

**Documentation:** `docs/schema-to-api/README.md`

---

### Conversation-to-API Pipeline

**Single command:** `/build-from-conversation`

Structured interview that generates an OpenAPI spec, then feeds into `/build-from-schema`:

```
/build-from-conversation

  [1] DISCOVERY → Structured interview about API requirements
      - What resources/entities does your API manage?
      - What operations are needed (CRUD, custom actions)?
      - What authentication model (JWT, OAuth2, API keys)?
      - What are the relationships between resources?
      - What are the performance requirements?
  [2] SPEC GENERATION → Generate OpenAPI 3.1 spec from interview answers
  [3] REVIEW → Present spec for user review and refinement
  [4] HANDOFF → Feed approved spec into /build-from-schema pipeline
```

This pipeline is ideal for greenfield projects where no OpenAPI spec exists yet. The structured interview ensures all requirements are captured before code generation begins.

**Documentation:** `docs/schema-to-api/conversation-pipeline.md`

---

### Aurelius-to-API Pipeline

**Single command:** `/build-from-aurelius`

Takes an Aurelius `build-spec.json` and generates the matching backend API:

```
/build-from-aurelius build-spec.json

  [1] SPEC INTAKE → Parse Aurelius build-spec.json
      - Extract component data requirements
      - Identify API calls and data shapes
      - Map frontend state to backend resources
  [2] OPENAPI GENERATION → Generate OpenAPI spec from frontend needs
      - Endpoint definitions for every data dependency
      - Request/response schemas matching frontend types
      - Auth requirements inferred from protected routes
  [3] HANDOFF → Feed generated spec into /build-from-schema pipeline
```

This creates a full-stack development workflow:
1. Design frontend in Figma/Canva
2. Build frontend with Aurelius (`/build-from-figma`)
3. Generate backend with Nerva (`/build-from-aurelius`)
4. Both share typed API client (`./scripts/generate-client.sh`)

**Documentation:** `docs/schema-to-api/aurelius-pipeline.md`

---
## API Development Standards

### TypeScript
- Strict mode enabled (`"strict": true` in tsconfig)
- No `any` types — use proper interfaces, generics, and Zod inference
- Zod schemas for runtime validation (request bodies, query params, path params)
- Infer TypeScript types from Zod schemas (`z.infer<typeof schema>`)
- Infer TypeScript types from Drizzle schemas (`typeof users.$inferSelect`)
- Export types alongside route handlers for client generation

### Hono Patterns
- Middleware composition with `app.use()` for cross-cutting concerns
- Route grouping with `app.route()` for resource-based organization
- Typed routes with Hono's `validator()` middleware and Zod
- Error handling with `app.onError()` and structured error responses
- Context typing with `Env` interface for bindings and variables
- Factory pattern for creating route groups with shared middleware

```typescript
// Route handler pattern
const usersRoutes = new Hono<{ Bindings: Env }>()
  .use("/*", authMiddleware)
  .get("/", zValidator("query", listQuerySchema), listUsers)
  .get("/:id", zValidator("param", idParamSchema), getUser)
  .post("/", zValidator("json", createUserSchema), createUser)
  .put("/:id", zValidator("json", updateUserSchema), updateUser)
  .delete("/:id", zValidator("param", idParamSchema), deleteUser);
```

### Database
- Drizzle schema as single source of truth for database structure
- Relations defined in schema files for type-safe joins
- Migration safety: always generate migrations, never push to production
- Connection pooling: use `pg` Pool for Node.js, Hyperdrive for Cloudflare Workers
- Transactions for multi-step operations
- Prepared statements for frequently executed queries
- Index definitions co-located with schema files

```typescript
// Drizzle schema pattern
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  role: varchar("role", { length: 50 }).notNull().default("user"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

### Testing Strategy
- **Unit tests** (Vitest): Service functions, utilities, validation logic
- **Integration tests** (Vitest + supertest): Full HTTP request/response cycles
- **Contract tests**: Validate API responses against OpenAPI specification
- **Load tests** (k6): Performance benchmarks for critical endpoints
- Test data factories for consistent, reproducible test fixtures
- Database seeding scripts for development and testing environments
- Test isolation: each test suite gets a fresh database transaction (rolled back)

### Security
- Input validation on every endpoint (Zod schemas, no unvalidated input)
- Parameterized queries via Drizzle ORM (SQL injection prevention)
- JWT best practices: short expiry, refresh tokens, audience/issuer validation
- Rate limiting middleware (configurable per-route and per-user)
- CORS configuration (explicit origin allowlist, no wildcards in production)
- Helmet-equivalent headers for Hono (X-Content-Type-Options, etc.)
- API key rotation support with graceful deprecation
- Request size limits to prevent payload abuse
- Dependency security audits via `./scripts/security-scan.sh`

---
### Development Workflow with Claude Code

**1. Schema-First API Development**
```bash
# Start feature branch
git checkout -b feature/users-api

# Generate API from OpenAPI spec
/build-from-schema openapi-spec.yaml

# Claude Code runs the full pipeline:
# - schema-architect generates Drizzle schema
# - test-writer-fixer writes failing tests (RED)
# - endpoint-generator creates Hono handlers (GREEN)
# - auth-guardian adds authentication middleware
# - api-tester runs integration + contract tests
```

**2. Database Schema Changes**
```bash
# Modify Drizzle schema files
# Claude Code uses migration-engineer agent

# Generate and review migration
pnpm drizzle-kit generate

# Apply migration (dev)
pnpm drizzle-kit migrate

# Seed with test data
./scripts/seed-database.sh
```

**3. Code Quality**
```bash
./scripts/check-types.sh
./scripts/run-tests.sh
./scripts/security-scan.sh
./scripts/load-test.sh
```

**4. Using Custom Agents**
```
User: "Design the database schema for a multi-tenant SaaS"
Claude: [Uses schema-architect agent]

User: "Add JWT authentication to all routes"
Claude: [Uses auth-guardian agent]

User: "Write integration tests for the orders endpoint"
Claude: [Uses api-tester agent]

User: "Optimize slow queries on the analytics endpoint"
Claude: [Uses performance-benchmarker agent]

User: "Generate OpenAPI documentation"
Claude: [Uses openapi-documenter agent]

User: "Set up CI/CD for Cloudflare Workers"
Claude: [Uses devops-automator agent]
```

**5. Full-Stack with Aurelius**
```
User: "I have an Aurelius frontend build-spec. Generate the backend."
Claude: [Uses /build-from-aurelius pipeline]
        → Parses frontend data requirements
        → Generates OpenAPI spec
        → Runs /build-from-schema pipeline
        → Generates typed API client for Aurelius
```

---

### Quick Command Reference

**API Development Pipelines:**
```bash
/build-from-schema <spec>       # Full autonomous schema-to-API pipeline
/build-from-conversation        # Guided interview to API pipeline
/build-from-aurelius <spec>     # Aurelius frontend to matching backend
```

**Git Workflows (via commit-commands):**
```bash
/commit                       # Structured commit
/commit-push-pr              # Commit + push + PR
/clean_gone                   # Clean merged branches
```

**GitHub CLI:**
```bash
gh pr create                  # Create pull request
gh pr list                    # List pull requests
gh issue create               # Create issue
```

**Code Quality & Testing:**
```bash
./scripts/run-tests.sh              # Vitest + coverage
./scripts/check-types.sh            # TypeScript check
./scripts/security-scan.sh          # Security audit
./scripts/load-test.sh              # k6 load tests
./scripts/generate-openapi-docs.sh  # OpenAPI documentation
./scripts/generate-client.sh        # Typed API client for Aurelius
```

**Database:**
```bash
./scripts/generate-migration.sh     # Generate Drizzle migration
./scripts/seed-database.sh          # Seed database with test data
pnpm drizzle-kit studio             # Open database GUI
```

**Project Setup:**
```bash
./scripts/setup-project.sh my-api --cloudflare  # New Cloudflare Workers project
./scripts/setup-project.sh my-api --node         # New Node.js project
```

---

**Last Updated:** 2026-03-29
**Architecture:** 24 agents, 12 skills, 4 plugins + gh CLI, 9 scripts