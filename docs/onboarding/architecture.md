# Architecture

Nerva is a **framework that generates APIs**, not an API itself. It provides Claude Code agents, skills, scripts, and templates that convert an OpenAPI specification into a fully working, tested, deployable API server.

## How It Works

```
OpenAPI Spec → [Nerva Pipeline] → Working API
                    │
                    ├── Drizzle ORM schemas
                    ├── Hono route handlers
                    ├── Zod validation
                    ├── Integration tests
                    ├── Authentication middleware
                    └── Deployment config
```

## Components

### Claude Code Agents (24)

Specialized AI agents that handle different aspects of API development. They are automatically invoked based on task context when you work in this repository with Claude Code.

| Category | Agents | Purpose |
|----------|--------|---------|
| Engineering | 6 | Architecture, prototyping, testing, error handling, performance, infrastructure |
| Schema & Database | 3 | Schema design, migrations, test data seeding |
| API Development | 3 | Endpoint generation, authentication, API documentation |
| Testing & QA | 1 | Integration tests, contract tests, load tests |
| DevOps | 1 | CI/CD, Docker, Cloudflare Workers deployment |
| Product | 3 | Sprint planning, feedback synthesis, shipping |
| Operations | 3 | Analytics, compliance, project management |
| Content & Docs | 2 | Documentation, naming consistency |
| Meta | 2 | Team motivation, humor |

Full catalog: [`.claude/CUSTOM-AGENTS-GUIDE.md`](../../.claude/CUSTOM-AGENTS-GUIDE.md)

### Skills (12)

Automated workflows triggered by slash commands or pipeline phases:

**Pipeline skills** run in sequence during `/build-from-schema`:
1. `schema-intake` — Parse OpenAPI spec into build-spec.json
2. `database-design` — Generate Drizzle schemas
3. `tdd-from-schema` — Write failing tests (TDD gate)
4. `route-generation` — Generate Hono handlers
5. `api-testing-verification` — Run test suites
6. `deployment-config-generator` — Generate deployment files

**Standalone skills** are available anytime:
- `api-authentication` — JWT, OAuth2, API keys, RBAC
- `api-validation` — Zod schemas, request/response middleware
- `database-migrations` — Migration generation and rollback
- `api-documentation` — OpenAPI spec, Scalar UI, Postman
- `api-performance` — Query optimization, caching
- `api-security` — Rate limiting, CORS, security headers

### Scripts (9)

Shell scripts for common development tasks:

| Script | Purpose |
|--------|---------|
| `setup-project.sh` | Initialize a new API project (--cloudflare or --node) |
| `run-tests.sh` | Vitest test suite with coverage |
| `check-types.sh` | TypeScript strict mode checking |
| `security-scan.sh` | Dependency and code security audit |
| `generate-migration.sh` | Drizzle migration generation |
| `seed-database.sh` | Populate database with test data |
| `load-test.sh` | k6 performance testing |
| `generate-openapi-docs.sh` | Build API documentation |
| `generate-client.sh` | Generate typed API client for frontends |

### Templates (4 directories)

Starter configurations for different deployment targets:

| Directory | Contents |
|-----------|----------|
| `templates/shared/` | ESLint, Prettier, TypeScript, Vitest configs |
| `templates/cloudflare-workers/` | Wrangler config with D1/KV/Hyperdrive bindings |
| `templates/node-server/` | Dockerfile + docker-compose with PostgreSQL |
| `templates/docker/` | Extended Docker setup with Redis + pgAdmin |

## Pipelines

### /build-from-schema (Primary)

The core 10-phase pipeline that converts an OpenAPI spec into a working API:

```
Phase 0: Schema Intake      → build-spec.json
Phase 1: Database Design     → Drizzle schemas + migration
Phase 2: TDD Gate (Hard)     → Failing integration tests
Phase 3: Route Generation    → Hono handlers (tests pass)
Phase 4: Auth & Middleware   → JWT, CORS, rate limiting, Zod
Phase 5: API Testing         → Integration + contract + load
Phase 6: Documentation       → OpenAPI docs, Postman
Phase 7: Quality Gate        → Types + coverage + security
Phase 8: Deployment Config   → Docker/Wrangler + CI/CD
Phase 9: Report              → Build report
```

The **TDD gate at Phase 2 is enforced** — tests must exist before route handlers are generated. This is not optional.

### /build-from-conversation

A structured interview that generates an OpenAPI spec, then feeds into /build-from-schema.

### /build-from-aurelius

Takes an Aurelius frontend `build-spec.json` and generates the matching backend API, creating a full-stack workflow.

## Deployment Targets

| Target | Use Case | Key Config |
|--------|----------|------------|
| **Cloudflare Workers** | Edge deployment, serverless, D1 database | `wrangler.toml` |
| **Node.js + Docker** | Traditional server, PostgreSQL, self-hosted | `Dockerfile` + `docker-compose.yml` |

The deployment target is configured in `.claude/pipeline.config.json` under `deployment.target`.

## Full-Stack with Aurelius

Nerva is designed to work with [Aurelius](https://github.com/PMDevSolutions/Aurelius) for full-stack development:

1. Design in Figma or Canva
2. Build frontend with Aurelius (`/build-from-figma` or `/build-from-canva`)
3. Generate backend with Nerva (`/build-from-aurelius`)
4. Share typed API client (`./scripts/generate-client.sh`)

## Architecture Decision Records

Key architectural decisions are documented as ADRs in [`docs/adr/`](../adr/README.md):

| ADR | Decision |
|-----|----------|
| [001](../adr/001-hono-over-express.md) | Hono as HTTP framework over Express |
| [002](../adr/002-drizzle-over-prisma.md) | Drizzle ORM over Prisma and TypeORM |
| [003](../adr/003-tdd-mandatory-gate.md) | TDD enforced as a hard pipeline gate |

To understand why a particular technology or approach was chosen, start with the ADRs. To propose a change, create a new ADR using the [template](../adr/000-template.md).

## Configuration

Pipeline behavior is controlled by `.claude/pipeline.config.json`. Key sections:

| Section | Controls |
|---------|----------|
| `tdd` | TDD enforcement, coverage thresholds |
| `database` | Provider, naming, migrations |
| `auth` | Authentication strategy, JWT settings |
| `testing` | Test frameworks, coverage requirements |
| `qualityGate` | Required checks before deployment |
| `deployment` | Target platform, environment configs |
| `security` | Rate limiting, CORS, headers |
| `api` | Pagination, versioning, health checks |
