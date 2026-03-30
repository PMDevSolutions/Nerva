---
name: database-migrations
description: >
  Manages Drizzle ORM migration generation, safety review, testing, and rollback
  procedures. Detects schema changes, runs drizzle-kit generate, reviews generated
  SQL for destructive operations, tests migrations against a copy database, and
  provides rollback strategies. Keywords: migration, drizzle-kit, schema-change,
  alter-table, add-column, rename, rollback, destructive, sql, migrate, database,
  version, deploy, ci, safety
---

# Database Migrations

## Purpose

Manages the full lifecycle of database schema changes using Drizzle ORM migrations.
Provides safe patterns for common operations (add column, rename, backfill),
reviews generated SQL for destructive changes, tests migrations before applying
to production, and documents rollback procedures.

## When to Use

- A Drizzle schema file has been modified and migrations need generating.
- The user says "migrate", "schema change", "add column", "rename table", or "rollback".
- Before deploying schema changes to staging or production.
- When reviewing or troubleshooting migration failures.

## Inputs

| Input | Required | Description |
|---|---|---|
| Drizzle schemas | Yes | `api/src/db/schema/*.ts` |
| Drizzle config | Yes | `api/drizzle.config.ts` |
| Existing migrations | No | `api/src/db/migrations/` |

## Steps

### Step 1 -- Detect Schema Changes

Before generating a migration, verify there are actual changes:

```bash
# Preview what drizzle-kit would generate without writing files
cd api && npx drizzle-kit generate --dry-run
```

If no changes detected, stop here. Do not generate empty migrations.

### Step 2 -- Generate Migration

```bash
cd api && npx drizzle-kit generate
```

This creates a new SQL file in `api/src/db/migrations/`. The file name follows
the pattern `NNNN_migration_name.sql`.

### Step 3 -- Review Generated SQL for Safety

**Destructive operation checklist:**

| Operation | Risk Level | Action Required |
|---|---|---|
| DROP TABLE | Critical | Require explicit confirmation, backup data first |
| DROP COLUMN | Critical | Require explicit confirmation, backup data first |
| ALTER COLUMN type | High | Check for data loss, test with production data copy |
| ALTER COLUMN NOT NULL | High | Ensure no null values exist, add default first |
| DROP INDEX | Medium | Verify no queries depend on it |
| RENAME TABLE | Medium | Update all references, use alias during transition |
| RENAME COLUMN | Medium | Update all application code references |
| ADD COLUMN NOT NULL | Medium | Must have DEFAULT or existing rows will fail |

**Safety review script:**

```typescript
// scripts/review-migration.ts
import { readFile, readdir } from 'fs/promises';
import path from 'path';

const DANGEROUS_PATTERNS = [
  { pattern: /DROP TABLE/i, level: 'CRITICAL', message: 'Table will be permanently deleted' },
  { pattern: /DROP COLUMN/i, level: 'CRITICAL', message: 'Column data will be permanently lost' },
  { pattern: /ALTER.*TYPE/i, level: 'HIGH', message: 'Column type change may cause data loss' },
  { pattern: /SET NOT NULL/i, level: 'HIGH', message: 'Existing null values will cause failure' },
  { pattern: /DROP INDEX/i, level: 'MEDIUM', message: 'Query performance may degrade' },
  { pattern: /RENAME/i, level: 'MEDIUM', message: 'Application code may need updating' },
  { pattern: /TRUNCATE/i, level: 'CRITICAL', message: 'All table data will be deleted' },
];

async function reviewLatestMigration() {
  const migrationsDir = path.join(process.cwd(), 'src', 'db', 'migrations');
  const files = await readdir(migrationsDir);
  const sqlFiles = files
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse();

  if (sqlFiles.length === 0) {
    console.log('No migration files found.');
    return;
  }

  const latestFile = sqlFiles[0];
  const sql = await readFile(
    path.join(migrationsDir, latestFile),
    'utf-8',
  );

  console.log(`Reviewing: ${latestFile}`);
  console.log('─'.repeat(60));

  const warnings: { level: string; message: string; line: string }[] = [];

  const lines = sql.split('\n');
  for (const line of lines) {
    for (const check of DANGEROUS_PATTERNS) {
      if (check.pattern.test(line)) {
        warnings.push({
          level: check.level,
          message: check.message,
          line: line.trim(),
        });
      }
    }
  }

  if (warnings.length === 0) {
    console.log('No dangerous operations detected. Migration looks safe.');
  } else {
    console.log(`Found ${warnings.length} warning(s):\n`);
    for (const w of warnings) {
      console.log(`  [${w.level}] ${w.message}`);
      console.log(`  SQL: ${w.line}\n`);
    }
  }
}

reviewLatestMigration();
```

Run the review:

```bash
cd api && pnpm tsx ../scripts/review-migration.ts
```

### Step 4 -- Safe Migration Patterns

**Adding a column with a default (safe):**

```typescript
// In Drizzle schema -- add field with default
export const users = pgTable('users', {
  // ... existing fields
  bio: text('bio').default(''), // New field with default
});
```

Generated SQL:

```sql
ALTER TABLE "users" ADD COLUMN "bio" text DEFAULT '';
```

**Adding a NOT NULL column to existing table (two-step):**

Step 1: Add as nullable with default:

```sql
-- Migration 0002
ALTER TABLE "users" ADD COLUMN "phone" text DEFAULT '';
```

Step 2: Backfill data, then add constraint:

```sql
-- Migration 0003
UPDATE "users" SET "phone" = '' WHERE "phone" IS NULL;
ALTER TABLE "users" ALTER COLUMN "phone" SET NOT NULL;
```

**Renaming a column safely (three-step):**

```sql
-- Migration 0004: Add new column
ALTER TABLE "users" ADD COLUMN "full_name" text;

-- Migration 0005: Backfill data
UPDATE "users" SET "full_name" = "name";
ALTER TABLE "users" ALTER COLUMN "full_name" SET NOT NULL;

-- Migration 0006: Drop old column (after all code is updated)
ALTER TABLE "users" DROP COLUMN "name";
```

**Adding an index concurrently (no table lock):**

```sql
-- Use CONCURRENTLY to avoid locking the table during index creation
CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_full_name_idx"
  ON "users" USING btree ("full_name");
```

Note: Drizzle-kit does not support CONCURRENTLY by default. You may need to
manually edit the generated SQL for large tables.

### Step 5 -- Test Migration Against Copy Database

```bash
# Create a copy of the production database for testing
pg_dump --no-owner --no-acl production_db > /tmp/prod_copy.sql
createdb migration_test
psql migration_test < /tmp/prod_copy.sql

# Run the migration against the copy
DATABASE_URL=postgresql://localhost/migration_test \
  npx drizzle-kit migrate

# Verify data integrity
psql migration_test -c "SELECT count(*) FROM users;"
psql migration_test -c "SELECT count(*) FROM books;"

# Run integration tests against the migrated copy
DATABASE_URL=postgresql://localhost/migration_test \
  pnpm vitest run

# Clean up
dropdb migration_test
```

### Step 6 -- Apply Migration

```bash
# Apply to staging first
cd api && DATABASE_URL=$STAGING_DATABASE_URL npx drizzle-kit migrate

# Verify staging
curl -s https://api-staging.example.com/health | jq .

# Apply to production
cd api && DATABASE_URL=$PRODUCTION_DATABASE_URL npx drizzle-kit migrate
```

### Step 7 -- Rollback Procedures

Drizzle ORM does not have built-in rollback. Use manual SQL scripts:

```typescript
// scripts/generate-rollback.ts
// For each migration, generate a corresponding rollback script

const ROLLBACK_MAP: Record<string, string> = {
  'ADD COLUMN': 'DROP COLUMN',
  'CREATE TABLE': 'DROP TABLE',
  'CREATE INDEX': 'DROP INDEX',
};

function generateRollbackSQL(forwardSQL: string): string {
  const lines = forwardSQL.split('\n').filter((l) => l.trim());
  const rollback: string[] = [];

  for (const line of lines.reverse()) {
    if (line.match(/ALTER TABLE .* ADD COLUMN/i)) {
      const table = line.match(/ALTER TABLE "(\w+)"/)?.[1];
      const column = line.match(/ADD COLUMN "(\w+)"/)?.[1];
      if (table && column) {
        rollback.push(`ALTER TABLE "${table}" DROP COLUMN "${column}";`);
      }
    }
    if (line.match(/CREATE TABLE/i)) {
      const table = line.match(/CREATE TABLE.*"(\w+)"/)?.[1];
      if (table) {
        rollback.push(`DROP TABLE IF EXISTS "${table}" CASCADE;`);
      }
    }
    if (line.match(/CREATE.*INDEX/i)) {
      const index = line.match(/INDEX.*"(\w+)"/)?.[1];
      if (index) {
        rollback.push(`DROP INDEX IF EXISTS "${index}";`);
      }
    }
  }

  return rollback.join('\n');
}
```

### Step 8 -- CI Migration Testing

Add migration testing to the CI/CD pipeline:

```yaml
# In .github/workflows/ci.yml
migration-test:
  runs-on: ubuntu-latest
  services:
    postgres:
      image: postgres:16-alpine
      env:
        POSTGRES_USER: test
        POSTGRES_PASSWORD: test
        POSTGRES_DB: test_db
      ports:
        - 5432:5432
      options: >-
        --health-cmd pg_isready
        --health-interval 10s
        --health-timeout 5s
        --health-retries 5
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '22'
    - run: cd api && pnpm install --frozen-lockfile
    - name: Run migrations
      run: cd api && npx drizzle-kit migrate
      env:
        DATABASE_URL: postgresql://test:test@localhost:5432/test_db
    - name: Verify schema
      run: cd api && npx drizzle-kit check
    - name: Run tests against migrated db
      run: cd api && pnpm vitest run
      env:
        DATABASE_URL: postgresql://test:test@localhost:5432/test_db
```

## Output

| Artifact | Location | Description |
|---|---|---|
| Migration files | `api/src/db/migrations/*.sql` | Generated SQL migrations |
| Migration review | Console output | Safety analysis of generated SQL |
| Rollback scripts | `api/src/db/rollbacks/*.sql` | Manual rollback SQL (if generated) |

## Integration

| Skill | Relationship |
|---|---|
| `database-design` | Initial migration generated during Phase 1 |
| `deployment-config-generator` | Migration step in CI/CD pipeline |
| `api-testing-verification` | Tests run against migrated database |
| `api-performance` | Index changes affect query performance |

### Migration Checklist

Before applying any migration to production:

1. Review generated SQL for destructive operations.
2. Test migration against a copy of production data.
3. Run integration tests against the migrated database.
4. Prepare rollback SQL script.
5. Apply to staging environment first.
6. Verify staging is healthy.
7. Apply to production during low-traffic window.
8. Monitor error rates and response times after deployment.
