# Scripts Reference

All scripts live in `scripts/` and run from the framework root. Scripts that
operate on a generated API project look for it at `api/` (override with
`NERVA_API_DIR`). Thresholds and policies come from
[`.claude/pipeline.config.json`](../.claude/pipeline.config.json); the shared
helpers live in [`scripts/lib/`](lib/).

Run everything at once with `pnpm verify` (or `/verify-all` inside Claude Code).

## Quality checks

### Verify All (`verify-all.sh`)
- **Purpose**: Run every local check in sequence and print a pass/fail summary. Backs the `/verify-all` and `/ci` slash commands.
- **Usage**: `./scripts/verify-all.sh [--json] [--ci] [--skip a,b] [--include a,b] [--list]`
- **Checks**: shell-syntax, js-syntax, json, pipeline-config, doc-counts, script-tests, types, tests, security, destructive-migrations. Checks whose subject is missing (no `api/`, no migrations) are skipped with a reason.
- **Exit codes**: 0 all passed or skipped, 1 a check failed, 2 usage error.

### Type Check (`check-types.sh`)
- **Purpose**: `tsc --noEmit` against `api/`. When `qualityGate.noAnyTypes` is on, also lists uses of `any` in `src/` as an advisory.
- **Usage**: `./scripts/check-types.sh [--strict] [--verbose]`

### Run Tests (`run-tests.sh`)
- **Purpose**: Vitest in `api/`. With `--coverage`, reads `coverage/coverage-summary.json` and fails when line coverage is below `tdd.coverageThreshold`.
- **Usage**: `./scripts/run-tests.sh [--unit|--integration|--all] [--coverage] [--watch]`
- **Config**: `testing.integrationTimeout`, `tdd.coverageThreshold`

### Security Scan (`security-scan.sh`)
- **Purpose**: `pnpm audit` plus a scan for hardcoded secrets, SQL interpolation, missing rate limiting or CORS, and stray `console.log`.
- **Usage**: `./scripts/security-scan.sh [--json] [--audit-only] [--patterns-only] [--level <level>] [--no-fail]`
- **Config**: `security.audit.level`, `security.audit.failOnVulnerability`, `security.audit.checkLockfile`

### Load Test (`load-test.sh`)
- **Purpose**: Run a k6 script; creates a baseline script on first run.
- **Usage**: `./scripts/load-test.sh [--vus N] [--duration 30s] [--script path] [--base-url url] [--json]`
- **Config**: `testing.loadTestVUs`, `testing.loadTestDuration`, `testing.loadTestThresholds.*`

## Framework integrity

### Validate Pipeline Config (`validate-pipeline-config.js`)
- **Purpose**: Validate `.claude/pipeline.config.json` against [`pipeline.config.schema.json`](../.claude/pipeline.config.schema.json), then check what the schema cannot express: phase dependency graph (unknown targets, cycles, reachability), `deployment.defaultTarget` in `targets`, semver `version`, coverage-threshold consistency.
- **Usage**: `node scripts/validate-pipeline-config.js [--config path] [--schema path] [--json]`
- **Exit codes**: 0 valid, 1 invalid, 2 usage/IO error.

### Check Doc Counts (`check-doc-counts.sh`)
- **Purpose**: Count agents, skills, scripts, and commands on disk and fail when a Markdown claim such as "24 specialized agents" disagrees. CHANGELOG, release notes, `docs/plans/`, and `examples/` are excluded.
- **Usage**: `./scripts/check-doc-counts.sh [--json] [--root dir]`
- **Runs on**: husky pre-commit and CI.

### Check Prerequisites (`check-prerequisites.sh`)
- **Purpose**: Report required software (git, Node, pnpm, bash), optional tools (docker, psql, jq, gh, shellcheck, k6, wrangler, sam, flyctl, railway), Claude Code plugins, and project state in a stable `[PASS]|[FAIL]|[SKIP]|[INFO]` layout.
- **Usage**: `./scripts/check-prerequisites.sh [--json]`
- **Exit codes**: 0 ready, 1 a required item is missing, 2 script error. The `claude` CLI and plugins never block.

## Database

### Generate Migration (`generate-migration.sh`)
- **Purpose**: `drizzle-kit generate`, print the SQL, run the destructive-DDL guard, then optionally apply.
- **Usage**: `./scripts/generate-migration.sh [name] [--apply]`
- **Config**: `database.blockDestructiveMigrations` (when true, findings block the apply step)

### Check Destructive Migrations (`check-destructive-migrations.js`)
- **Purpose**: Scan migration SQL for DROP TABLE/COLUMN/CONSTRAINT/NOT NULL/TYPE/SCHEMA/INDEX, TRUNCATE, and unbounded DELETE after stripping comments. A file opts out with a header line `-- nerva:allow-destructive: <reason>`. Copied into every generated project as `api/scripts/check-destructive-migrations.mjs` (`pnpm db:check-destructive`).
- **Usage**: `node scripts/check-destructive-migrations.js [--dir path] [--json] [--warn-only]`
- **Exit codes**: 0 clean, 1 findings, 2 usage/IO error.
- **Docs**: [docs/api-development/migration-safety.md](../docs/api-development/migration-safety.md)

### Seed Database (`seed-database.sh`)
- **Purpose**: Run `src/db/seed.ts` against the selected environment; production requires typing `yes`.
- **Usage**: `./scripts/seed-database.sh [--env development|staging|production]`

## Generation

### Setup Project (`setup-project.sh`)
- **Purpose**: Scaffold a new API project from `templates/` for one deployment target.
- **Usage**: `./scripts/setup-project.sh <name> [--cloudflare|--node|--lambda|--railway|--fly] [--multi-tenant] [--dry-run]`
- **Generated extras**: `api/pnpm-workspace.yaml` (allows esbuild/workerd install scripts on pnpm 10 through 12), `api/scripts/check-destructive-migrations.mjs`, `api/src/db/schema-drift.ts` (`pnpm db:check-drift[:strict]`), `.github/workflows/schema-drift.yml` and `schema-applied.yml`. Cloudflare projects get `deploy:staging` and `deploy:production` scripts and a `deploy` script that refuses to publish the development environment.

### Generate OpenAPI Docs (`generate-openapi-docs.sh`)
- **Usage**: `./scripts/generate-openapi-docs.sh [--serve] [--port 8080] [--output path]`

### Generate Client (`generate-client.sh`)
- **Purpose**: Typed TypeScript client from the OpenAPI spec for Aurelius frontends.
- **Usage**: `./scripts/generate-client.sh [--spec path] [--output dir] [--runtime]`

## Shared library (`scripts/lib/`)

| File | Provides |
|------|----------|
| `common.sh` | `info`/`success`/`warn`/`error`/`step`, `say_*` status prefixes, `common_project_root`, `common_api_dir`, `have_cmd`, `require_cmd`, `common_track_tmpfile`, `common_config_get <dotted.path> [default]` |
| `colors.sh` | ANSI color variables; empty when piped or when `NO_COLOR` is set |
| `pipeline-config.js` | `getValue(path, default)` / `loadConfig()`; CLI `node scripts/lib/pipeline-config.js get <path> [default]`; honors `NERVA_PIPELINE_CONFIG` |

## Tests

Script and hook tests live in `scripts/__tests__/` and run with `pnpm test`
(Vitest, sequential, `NO_COLOR` set). Each test shells out to the real script
with a fixture directory or the repo itself. CI runs them in the `script-tests`
job.
