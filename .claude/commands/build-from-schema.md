---
allowed-tools: Skill, Agent, Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# /build-from-schema — Autonomous OpenAPI-to-Working-API Pipeline

You are the master orchestrator for converting an OpenAPI specification into a fully working, tested API server. You receive an OpenAPI spec file path and guide the entire process through 10 phases, using specialized skills and agents.

**Key enforcement rules:**
- **TDD is mandatory** — Phase 2 (TDD) MUST complete before Phase 3 (Route Generation). No exceptions.
- **Schema-first** — Database schema is derived from the API spec, not improvised.
- **Contract compliance** — Generated routes must match the OpenAPI spec exactly.
- **Security by default** — Auth, rate limiting, CORS, and validation are always generated.

## Input

The user provides: `$ARGUMENTS` (path to an OpenAPI spec file, YAML or JSON)

If no arguments provided, ask the user for the spec file path or offer to run `/build-from-conversation` instead.

## Configuration

Load `.claude/pipeline.config.json` at the start. This provides:
- TDD enforcement settings and coverage thresholds
- Database configuration and migration safety
- Auth strategy defaults
- Testing configuration (integration, contract, load)
- Quality gate thresholds
- Deployment target configuration
- API conventions (pagination, versioning)

## Progress Tracking

Use `TodoWrite` to create a master checklist. Update each item as phases complete. This enables interrupted sessions to resume.

```
[ ] Phase 0: Schema Intake — Parse OpenAPI spec → build-spec.json
[ ] Phase 1: Database Design — Drizzle schema + initial migration
[ ] Phase 2: TDD Gate (HARD) — Failing integration tests for every endpoint (RED)
[ ] Phase 3: Route Generation — Hono handlers + middleware that pass tests (GREEN)
[ ] Phase 4: Auth & Middleware — JWT/OAuth2, rate limiting, CORS, Zod validation
[ ] Phase 5: API Testing — Integration tests, contract tests, load tests
[ ] Phase 6: Documentation — OpenAPI docs, README, Postman collection
[ ] Phase 7: Quality Gate — Type check + coverage + security audit
[ ] Phase 8: Deployment Config — Dockerfile, docker-compose, wrangler.toml, CI/CD
[ ] Phase 9: Report — Build report with endpoint inventory, test results
```

For each endpoint group, track: `[ ] Resource: schema → tests-written → routes-implemented → tested`

## Phase 0: Schema Intake

Invoke the `schema-intake` skill.

**Input:** The OpenAPI spec file from $ARGUMENTS
**Output:** `.claude/plans/build-spec.json`

This phase:
1. Detect input format (YAML or JSON)
2. Parse and validate the OpenAPI 3.x spec
3. Extract paths, schemas, security definitions, parameters
4. Map to internal build-spec format with endpoint inventory
5. Identify resource models and their relationships
6. Determine auth strategy from security schemes
7. Ask user 2-3 clarifying questions (deployment target, database provider, any custom business logic)

**Resume check:** If `.claude/plans/build-spec.json` already exists, ask the user if they want to reuse it or regenerate.

## Phase 1: Database Design

Invoke the `database-design` skill.

**Input:** `.claude/plans/build-spec.json`
**Output:** `api/src/db/schema/*.ts`, `api/src/db/migrations/`, Zod validators in `api/src/types/`

This phase:
1. Read build-spec.json for model definitions
2. Map OpenAPI schemas to PostgreSQL tables via Drizzle ORM
3. Generate one schema file per resource in `api/src/db/schema/`
4. Create relations (one-to-many, many-to-many with join tables)
5. Add indexes for foreign keys, unique constraints, common query patterns
6. Generate Zod validators from Drizzle schemas using drizzle-zod
7. Run `drizzle-kit generate` for the initial migration
8. Create `api/src/db/index.ts` with database connection setup

Process models in dependency order: independent tables first, then tables with foreign keys.

**Resume check:** If schema files exist, ask user if they want to regenerate or extend.

## Phase 2: TDD Gate (HARD GATE)

Invoke the `tdd-from-schema` skill.

**Input:** `build-spec.json` + Drizzle schemas + Zod validators
**Output:** `api/tests/integration/*.test.ts`, `api/tests/fixtures/*.ts`

This phase:
1. Read build-spec.json for endpoint inventory
2. For each endpoint, write integration tests using supertest + Vitest:
   - Correct HTTP method and path
   - Expected response status codes (200, 201, 400, 401, 404, etc.)
   - Response body shape validation against Zod schemas
   - Request validation (missing fields, wrong types, boundary values)
   - Auth requirements (protected vs public endpoints)
   - Pagination, filtering, sorting for list endpoints
3. Generate test data factories in `api/tests/fixtures/`
4. Run `pnpm vitest run` to confirm RED (all tests fail — no route handlers yet)

**Critical:** This phase MUST complete and confirm RED before Phase 3 begins. If any test passes unexpectedly, investigate — it indicates a test that doesn't verify anything meaningful.

## Phase 3: Route Generation

Invoke the `route-generation` skill.

**Input:** `build-spec.json`, failing test files, Drizzle schemas, Zod validators
**Output:** `api/src/routes/*.ts`, `api/src/services/*.ts`

This phase:
1. Create service layer in `api/src/services/` (business logic, database queries)
2. Create route handlers in `api/src/routes/` using Hono
3. Wire up Zod validation middleware with @hono/zod-validator
4. Implement proper error handling with typed error classes
5. Wire routes into the main Hono app in `api/src/index.ts`
6. Run `pnpm vitest run` after each route group to confirm GREEN

**Critical rule:** If tests fail, fix the route handler — never modify the test files from Phase 2.

Process endpoints by resource group: users routes, then posts routes, etc.

## Phase 4: Auth & Middleware

Invoke the `api-authentication` and `api-validation` skills.

**Input:** `build-spec.json` (auth strategy), route files
**Output:** `api/src/middleware/*.ts`, updated route files

This phase:
1. Read auth strategy from build-spec.json
2. Generate auth middleware (JWT verification, API key validation, or OAuth2)
3. Generate rate limiting middleware
4. Configure CORS middleware
5. Add Zod request/response validation middleware to all routes
6. Add security headers middleware
7. Wire middleware into route groups
8. Run tests to verify auth-protected endpoints return 401 without credentials

## Phase 5: API Testing

Invoke the `api-testing-verification` skill.

**Input:** Running API with all routes and middleware
**Output:** Test reports

This phase:
1. **Integration tests:** `pnpm vitest run --coverage` — all tests must pass, coverage must meet threshold
2. **Contract tests:** Validate every response against the original OpenAPI spec
3. **Load tests:** Run k6 baseline load test (gradual ramp to configured VUs)
4. Generate test report with results

If integration tests fail, fix route handlers (not tests). If contract tests show drift, reconcile routes with spec.

## Phase 6: Documentation

Invoke the `api-documentation` skill.

**Input:** Hono routes, Zod schemas, OpenAPI spec
**Output:** `docs/openapi.yaml`, API README, Postman collection

This phase:
1. Generate/update OpenAPI 3.1 spec from Hono routes + Zod schemas
2. Set up Scalar interactive docs endpoint at `/docs`
3. Generate Postman collection for import
4. Write API README with quickstart, authentication guide, endpoint reference
5. Generate typed client SDK stubs (for Aurelius frontends)

## Phase 7: Quality Gate

Run all quality checks. All must pass for pipeline success.

```bash
# 1. Unit + integration test coverage (threshold from pipeline.config.json)
pnpm vitest run --coverage

# 2. TypeScript type checking
pnpm tsc --noEmit

# 3. Production build
pnpm build

# 4. Security audit
./scripts/security-scan.sh

# 5. ESLint
pnpm eslint . --ext .ts
```

If any check fails, attempt to fix automatically (max 2 attempts per check). If still failing after fixes, report the failure and continue to the report phase.

## Phase 8: Deployment Config

Invoke the `deployment-config-generator` skill.

**Input:** `build-spec.json` (deployment target), project structure
**Output:** Deployment configuration files

This phase:
1. Read deployment target from build-spec.json
2. If Cloudflare Workers: generate `wrangler.toml` with bindings, environments
3. If Node.js: generate `Dockerfile`, `docker-compose.yml` with PostgreSQL
4. Generate GitHub Actions CI/CD workflow (test → build → deploy)
5. Generate `.env.example` with all required environment variables
6. Create health check endpoint at `GET /health`

## Phase 9: Report

Write `.claude/build-reports/build-report.md` with:

- Build summary (endpoints generated, models, auth strategy, deployment target)
- Endpoint inventory table (method, path, auth, description)
- Database schema diagram (text-based ERD)
- Test results (integration: pass/fail counts, coverage %, contract: compliance %)
- Load test results (p50, p95, p99 latency, max RPS, error rate)
- Quality gate results (each check with pass/fail)
- Security audit summary
- Deployment configuration summary
- Remaining issues requiring manual attention
- Next steps recommendations

Create the `.claude/build-reports/` directory if it doesn't exist.

Present the report summary to the user when complete.

## Error Recovery

- **OpenAPI spec invalid:** Show validation errors, ask user to fix and retry.
- **Database connection failed:** Check .env configuration, suggest using Supabase/Neon for quick setup.
- **Tests won't pass after 3 attempts:** Mark endpoint as needing manual intervention, continue with remaining.
- **Build fails:** Check TypeScript errors first, then dependency issues.
- **Session interrupted:** On resume, check TodoWrite progress. Skip completed phases, resume from first incomplete item.

## Completion

When all phases complete, present:

1. The build report summary
2. Count of endpoints built, tested, and documented
3. Any items needing manual review
4. How to start the API: `pnpm dev` or `npx wrangler dev`
5. Where to find docs: `http://localhost:8787/docs`
