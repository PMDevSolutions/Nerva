# Migration Safety

Two guards keep a Nerva project's database schema and its Drizzle declarations from silently diverging:

- **Destructive migration guard** (`check-destructive-migrations`) — a static scan of committed `*.sql` migration files. No database needed.
- **Schema drift check** (`schema-drift.ts`) — compares what `src/db/schema.ts` declares with what the production database actually has.

Both ship in every generated project (`api/scripts/check-destructive-migrations.mjs`, `api/src/db/schema-drift.ts`) together with two GitHub Actions workflows, and the framework repo runs the destructive guard itself from `scripts/generate-migration.sh`.

## Destructive migration guard

`drizzle-kit generate` diffs the schema against its snapshot. If a developer's local database (or the snapshot) has drifted, the generated migration can contain a "reconcile" plan — `DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN ... DROP NOT NULL` — that deletes production data when applied. Nerva migrations are additive by policy, so any destructive DDL in a committed migration is treated as a mistake until a human says otherwise.

The guard strips `--` and `/* */` comments (string literals and `$$` bodies are preserved) and flags:

| Pattern | Example |
|---------|---------|
| `DROP TABLE` | `DROP TABLE "sessions";` |
| `DROP COLUMN` | `ALTER TABLE "users" DROP COLUMN "email";` |
| `DROP CONSTRAINT` | `ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";` |
| `DROP NOT NULL` | `ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL;` |
| `DROP TYPE` / `DROP SCHEMA` / `DROP INDEX` | `DROP TYPE "role";` |
| `TRUNCATE` | `TRUNCATE "audit_log";` |
| `DELETE FROM` without `WHERE` | `DELETE FROM "sessions";` (also inside `DO $$ ... $$` blocks) |

Prose mentions in comments are never flagged.

```bash
# Framework repo (scans ./src/db/migrations, ./api/src/db/migrations, ./drizzle,
# or $NERVA_API_DIR/src/db/migrations — first one that exists)
pnpm check:destructive
node scripts/check-destructive-migrations.js --dir path/to/migrations --json

# Generated project (from api/)
pnpm db:check-destructive
```

Flags: `--dir <path>`, `--json` (machine-readable report), `--warn-only` (report but exit 0), `--help`.

### Blocking vs. warn-only

Inside the framework repo the guard reads `database.blockDestructiveMigrations` from `.claude/pipeline.config.json` (default `true`). `scripts/generate-migration.sh` runs the guard right after `drizzle-kit generate`; when blocking is on and findings exist, the migration is **not applied** and the script exits 1. Set the key to `false` to downgrade findings to warnings. The standalone copy in a generated project has no config and always blocks unless `--warn-only` is passed.

### Allowlisting an intended destructive migration

A reviewed destructive change opts out with a header comment line in the migration file. The reason is mandatory — a bare marker is itself reported as a finding.

```sql
-- nerva:allow-destructive: sessions moved to Redis in #42; table has been empty since v1.3
DROP TABLE "sessions";
```

Allowlisted files are reported as skipped with their reason, so the exception stays visible in CI output and code review.

## Schema drift check

`schema-drift.ts` introspects `information_schema` / `pg_catalog` and asserts that every `pgTable`, column, `NOT NULL` constraint and `pgEnum` value declared in `src/db/schema.ts` exists in the target database. The check is asymmetric on purpose: extra tables or columns in the database are fine (in-flight deprecations); anything *missing* is drift, because code that depends on it will fail at runtime. Column types, indexes and foreign keys are not compared.

The target comes from **`PROD_DATABASE_URL` only**. `DATABASE_URL` is never used as a fallback, so a local database can never be mistaken for production. The connection string is printed with the password masked. A read-only role is sufficient.

```bash
cd api
PROD_DATABASE_URL=postgres://... pnpm db:check-drift          # lenient
PROD_DATABASE_URL=postgres://... pnpm db:check-drift:strict   # strict
```

### Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Lenient** (default) | `pnpm db:check-drift` | Drift that a committed file in `src/db/migrations/*.sql` would fix (a `CREATE TABLE`, `ADD COLUMN`, `SET NOT NULL`, `CREATE TYPE` or `ADD VALUE` for the missing object) is reported as *pending* and tolerated. This is the PR gate: the migration ships in the same PR. |
| **Strict** | `--strict` or `SCHEMA_DRIFT_STRICT=1` | A covering migration does not excuse drift. If production is missing it, the migration merged but was never applied — the check fails. This is the post-deploy / scheduled gate. |

To cover additional schema modules (for example `src/tenancy/schema.ts` in a `--multi-tenant` project), add them to the `SCHEMA_MODULES` list at the top of `schema-drift.ts`.

## Workflows

Generated projects get two workflows in `.github/workflows/`:

- **`schema-drift.yml`** — runs on pull requests that touch `api/src/db/**`. Step 1 runs the destructive guard (no secrets needed). Step 2 runs the lenient drift check against production.
- **`schema-applied.yml`** — runs daily at 13:00 UTC and on `workflow_dispatch`, in strict mode. On failure it opens (or comments on) a single issue labeled `schema-drift`; on success it comments on and closes any open `schema-drift` issue, so the alert self-heals once production is reconciled. It is deliberately not a push gate: production legitimately lags a merged schema PR until the deploy applies the migration.

### The `PROD_DATABASE_URL` secret

Add `PROD_DATABASE_URL` under **Settings → Secrets and variables → Actions** with a read-only connection string to the production database. Until it is set, both workflows print a `::notice::` explaining how to configure it and exit green — the destructive guard still runs, only the database-backed steps are skipped.

## Exit codes

| Code | `check-destructive-migrations` | `schema-drift.ts` |
|------|-------------------------------|-------------------|
| `0` | No findings, or findings with `--warn-only` / blocking disabled | No unresolved drift (lenient: pending migrations tolerated) |
| `1` | Destructive findings while blocking | Unresolved drift |
| `2` | Usage error or migrations directory missing/unreadable | `PROD_DATABASE_URL` unset, or the database is unreachable |

`scripts/generate-migration.sh` exits 1 when the guard blocks the freshly generated migration and prints the allowlist instructions.
