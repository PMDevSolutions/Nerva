# Nerva

A Claude Code-integrated API & backend development framework with TypeScript, Hono, Drizzle ORM, and automated schema-to-API pipelines.

## What This Framework Provides

- **24 Custom Agents** — Specialized AI agents for backend architecture, database design, testing, security, deployment, and more
- **12 Development Skills** — Automated workflows for schema parsing, TDD, route generation, authentication, validation, documentation
- **10-Phase Schema-to-API Pipeline** — Convert OpenAPI specs into fully working, tested API servers with a single command
- **TDD-Mandatory Development** — Integration tests written before route handlers, hard gate enforced
- **Dual Deployment Targets** — Cloudflare Workers (edge) or Node.js (Docker) with one config change
- **Testing Stack** — Vitest, supertest, contract tests against OpenAPI, k6 load tests
- **Schema-First Design** — Database schemas, types, and validators all derived from your API spec

## Quick Start

```bash
# Clone the repository
git clone <repository-url>
cd nerva

# Initialize a new API project
./scripts/setup-project.sh my-api --cloudflare   # or --node

# Install dependencies
cd api && pnpm install

# Start development
pnpm dev
```

### Build from OpenAPI Spec (Autonomous Pipeline)

```
/build-from-schema openapi-spec.yaml
```

This runs a 10-phase autonomous pipeline:

```
[0] Schema Intake   → Parse OpenAPI spec → build-spec.json
[1] Database Design  → Drizzle schema + initial migration
[2] TDD Gate (Hard)  → Failing integration tests for every endpoint (RED)
[3] Route Generation → Hono handlers that pass the tests (GREEN)
[4] Auth & Middleware → JWT/OAuth2, rate limiting, CORS, Zod validation
[5] API Testing      → Integration tests, contract tests, load tests
[6] Documentation    → OpenAPI docs, Postman collection, API README
[7] Quality Gate     → Type check + coverage + security audit
[8] Deploy Config    → Dockerfile, wrangler.toml, CI/CD pipeline
[9] Report           → Build report with endpoint inventory + test results
```

### Build from Conversation

```
/build-from-conversation
```

Structured interview (7-10 questions) that generates an OpenAPI spec, then feeds into the pipeline above.

### Build from Aurelius

```
/build-from-aurelius path/to/build-spec.json
```

Takes an Aurelius frontend build-spec.json and generates the matching backend API.

## Directory Structure

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
│   │   └── types/          # Generated TypeScript types + Zod validators
│   ├── tests/
│   │   ├── integration/    # API integration tests (supertest)
│   │   ├── unit/           # Service unit tests
│   │   └── fixtures/       # Test data factories
│   └── package.json
├── scripts/                # Automation scripts (9 total)
├── templates/              # Starter configs
├── docs/                   # Documentation
├── .claude/                # Claude Code configuration
│   ├── agents/             # 24 custom agents
│   ├── skills/             # 12 development skills
│   ├── commands/           # Slash commands
│   └── pipeline.config.json
├── CLAUDE.md               # Claude Code project instructions
└── README.md               # This file
```

## 24 Custom Agents

| Category | Count | Key Agents |
|----------|-------|------------|
| Engineering | 6 | backend-architect, rapid-prototyper, test-writer-fixer, error-boundary-architect, performance-benchmarker, infrastructure-maintainer |
| Schema & Database | 3 | schema-architect, migration-engineer, data-seeder |
| API Development | 3 | endpoint-generator, auth-guardian, openapi-documenter |
| Testing & QA | 1 | api-tester |
| DevOps | 1 | devops-automator |
| Product | 3 | sprint-prioritizer, feedback-synthesizer, project-shipper |
| Operations | 3 | analytics-reporter, legal-compliance-checker, studio-producer |
| Content & Docs | 2 | content-creator, brand-guardian |
| Meta | 2 | joker, studio-coach |

Full catalog: `.claude/CUSTOM-AGENTS-GUIDE.md`

## 12 Development Skills

### Pipeline Skills (Phases 0-8)

| # | Skill | Purpose |
|---|-------|---------|
| 1 | schema-intake | OpenAPI parsing + build-spec.json generation |
| 2 | database-design | Drizzle schema generation from API spec |
| 3 | tdd-from-schema | Write failing integration tests before handlers |
| 4 | route-generation | Generate Hono handlers that pass the tests |
| 5 | api-testing-verification | Integration + contract + load tests |
| 6 | deployment-config-generator | Docker, wrangler.toml, CI/CD generation |

### API Development Skills

| # | Skill | Purpose |
|---|-------|---------|
| 7 | api-authentication | JWT, OAuth2, API keys, RBAC for Hono |
| 8 | api-validation | Zod schemas, request/response validation |
| 9 | database-migrations | Drizzle migration generation, rollback safety |
| 10 | api-documentation | OpenAPI 3.1 spec, Scalar UI, Postman export |
| 11 | api-performance | Query optimization, caching, connection pooling |
| 12 | api-security | Rate limiting, CORS, security headers, audit |

## Scripts

```bash
./scripts/setup-project.sh my-api --cloudflare  # Initialize project
./scripts/run-tests.sh --coverage               # Run tests
./scripts/check-types.sh                        # TypeScript check
./scripts/security-scan.sh                      # Security audit
./scripts/generate-migration.sh                 # Drizzle migration
./scripts/seed-database.sh                      # Seed database
./scripts/load-test.sh --vus 50 --duration 30s  # Load test
./scripts/generate-openapi-docs.sh              # OpenAPI docs
./scripts/generate-client.sh --spec docs/openapi.yaml  # Typed client
```

## Templates

| Directory | Contents |
|-----------|----------|
| `templates/shared/` | ESLint, Prettier, TypeScript, Vitest configs |
| `templates/cloudflare-workers/` | Wrangler config with Hyperdrive |
| `templates/node-server/` | Dockerfile + docker-compose with PostgreSQL |
| `templates/docker/` | Extended Docker with Redis + pgAdmin |

## Claude Code Plugins

```
episodic-memory    # Persistent memory across sessions
commit-commands    # Git workflow automation (/commit, /commit-push-pr)
superpowers        # Advanced development workflows (TDD, planning, debugging)
ai-taskmaster      # Task management (local)
```

GitHub integration via `gh` CLI.

## Documentation Index

| Document | Location | Description |
|----------|----------|-------------|
| Project instructions | `CLAUDE.md` | Full project config for Claude Code |
| Pipeline guide | `docs/schema-to-api/README.md` | Pipeline overview and troubleshooting |
| API standards | `docs/api-development/README.md` | TypeScript, Hono, testing conventions |
| Agent catalog | `.claude/CUSTOM-AGENTS-GUIDE.md` | All 24 agents with use cases |
| Plugin reference | `.claude/PLUGINS-REFERENCE.md` | Plugin configuration and commands |

## License

MIT
