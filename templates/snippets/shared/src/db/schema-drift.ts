/**
 * schema-drift.ts — Assert that the production database has everything the
 * Drizzle schema declares.
 *
 * Run with tsx (dev dependency of every generated project):
 *
 *   PROD_DATABASE_URL=postgres://... pnpm db:check-drift          # lenient
 *   PROD_DATABASE_URL=postgres://... pnpm db:check-drift:strict   # strict
 *
 * The check is deliberately asymmetric: the database having *extra* tables or
 * columns is fine (in-flight deprecations); the database *missing* anything
 * declared in the schema is drift, because application code that depends on
 * the missing object will fail at runtime.
 *
 * What is checked:
 *   - every declared pgTable exists
 *   - every declared column exists on its table
 *   - every column declared NOT NULL is NOT NULL in the database
 *   - every declared pgEnum exists with every declared value
 *
 * Not checked (on purpose): exact column types, indexes, foreign keys.
 *
 * Modes:
 *   lenient (default) — the PR gate. Drift that a committed migration file in
 *     src/db/migrations would resolve is tolerated, since the migration ships
 *     in the same PR and is applied on deploy.
 *   strict (--strict or SCHEMA_DRIFT_STRICT=1) — the post-deploy / scheduled
 *     gate. A committed-but-unapplied migration does not excuse drift: if the
 *     database is missing it, the check fails.
 *
 * The target database comes from PROD_DATABASE_URL only. DATABASE_URL is
 * never used as a fallback, so a local dev database can never be mistaken for
 * production.
 *
 * Exit codes:
 *   0 = no unresolved drift
 *   1 = unresolved drift (details printed)
 *   2 = configuration problem (PROD_DATABASE_URL unset or unreachable)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig, isPgEnum } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema.js';

// Every module whose pgTable / pgEnum exports should exist in production.
// Add further schema modules here (for example './tenancy/schema.js' in a
// multi-tenant project) so the check covers them too.
const SCHEMA_MODULES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['schema.ts', schema as Record<string, unknown>],
];

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeclaredColumn {
  name: string;
  notNull: boolean;
}

interface DeclaredTable {
  schema: string;
  name: string;
  columns: DeclaredColumn[];
  source: string;
}

interface DeclaredEnum {
  schema: string;
  name: string;
  values: readonly string[];
  source: string;
}

export interface Declared {
  tables: DeclaredTable[];
  enums: DeclaredEnum[];
}

interface LiveColumn {
  isNullable: boolean;
}

/** `schema.table` → column name → metadata */
type LiveTables = Map<string, Map<string, LiveColumn>>;
/** `schema.enum` → values */
type LiveEnums = Map<string, Set<string>>;

export interface Live {
  tables: LiveTables;
  enums: LiveEnums;
}

export type Drift =
  | { kind: 'missing_table'; schema: string; table: string; source: string }
  | { kind: 'missing_column'; schema: string; table: string; column: string; source: string }
  | { kind: 'nullability'; schema: string; table: string; column: string; source: string }
  | { kind: 'missing_enum'; schema: string; enum: string; source: string }
  | { kind: 'missing_enum_value'; schema: string; enum: string; value: string; source: string };

export interface MigrationFile {
  filename: string;
  content: string;
}

export interface Classified {
  drift: Drift;
  coveredBy: MigrationFile | null;
}

function qualified(schemaName: string, name: string): string {
  return `${schemaName}.${name}`;
}

// ---------------------------------------------------------------------------
// Declared schema (from Drizzle)
// ---------------------------------------------------------------------------

export function collectDeclared(
  modules: ReadonlyArray<readonly [string, Record<string, unknown>]> = SCHEMA_MODULES,
): Declared {
  const tables: DeclaredTable[] = [];
  const enums: DeclaredEnum[] = [];

  for (const [sourceName, mod] of modules) {
    for (const [exportName, value] of Object.entries(mod)) {
      const source = `${sourceName} (export ${exportName})`;
      if (is(value, PgTable)) {
        const cfg = getTableConfig(value);
        tables.push({
          schema: cfg.schema ?? 'public',
          name: cfg.name,
          columns: cfg.columns.map((c) => ({ name: c.name, notNull: c.notNull })),
          source,
        });
      } else if (isPgEnum(value)) {
        enums.push({
          schema: value.schema ?? 'public',
          name: value.enumName,
          values: value.enumValues,
          source,
        });
      }
    }
  }

  return { tables, enums };
}

// ---------------------------------------------------------------------------
// Live schema (from information_schema / pg_catalog)
// ---------------------------------------------------------------------------

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  is_nullable: 'YES' | 'NO';
}

interface EnumRow {
  enum_schema: string;
  enum_name: string;
  value: string;
}

async function introspect(sql: postgres.Sql): Promise<Live> {
  const tables: LiveTables = new Map();
  const enums: LiveEnums = new Map();

  const columnRows = await sql<ColumnRow[]>`
    SELECT table_schema, table_name, column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
  `;
  for (const row of columnRows) {
    const key = qualified(row.table_schema, row.table_name);
    let table = tables.get(key);
    if (!table) {
      table = new Map();
      tables.set(key, table);
    }
    table.set(row.column_name, { isNullable: row.is_nullable === 'YES' });
  }

  const enumRows = await sql<EnumRow[]>`
    SELECT n.nspname AS enum_schema, t.typname AS enum_name, e.enumlabel AS value
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
  `;
  for (const row of enumRows) {
    const key = qualified(row.enum_schema, row.enum_name);
    let values = enums.get(key);
    if (!values) {
      values = new Set();
      enums.set(key, values);
    }
    values.add(row.value);
  }

  return { tables, enums };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export function diff(declared: Declared, live: Live): Drift[] {
  const drift: Drift[] = [];

  for (const t of declared.tables) {
    const liveTable = live.tables.get(qualified(t.schema, t.name));
    if (!liveTable) {
      drift.push({ kind: 'missing_table', schema: t.schema, table: t.name, source: t.source });
      continue;
    }
    for (const c of t.columns) {
      const liveColumn = liveTable.get(c.name);
      if (!liveColumn) {
        drift.push({
          kind: 'missing_column',
          schema: t.schema,
          table: t.name,
          column: c.name,
          source: t.source,
        });
        continue;
      }
      // Schema says NOT NULL but the database allows NULL: code relying on
      // the guarantee can crash on real NULLs. The reverse (schema nullable,
      // database NOT NULL) is tolerated; code is already defensive.
      if (c.notNull && liveColumn.isNullable) {
        drift.push({
          kind: 'nullability',
          schema: t.schema,
          table: t.name,
          column: c.name,
          source: t.source,
        });
      }
    }
  }

  for (const e of declared.enums) {
    const liveEnum = live.enums.get(qualified(e.schema, e.name));
    if (!liveEnum) {
      drift.push({ kind: 'missing_enum', schema: e.schema, enum: e.name, source: e.source });
      continue;
    }
    for (const v of e.values) {
      if (!liveEnum.has(v)) {
        drift.push({
          kind: 'missing_enum_value',
          schema: e.schema,
          enum: e.name,
          value: v,
          source: e.source,
        });
      }
    }
  }

  return drift;
}

// ---------------------------------------------------------------------------
// Pending-migration coverage (lenient mode)
// ---------------------------------------------------------------------------
//
// Every src/db/migrations/*.sql file is scanned, not only unapplied ones: an
// applied migration's objects would not be reported as drift in the first
// place, and this avoids depending on the __drizzle_migrations journal.
// Matching is regex-based (no SQL parser); identifiers may be bare, quoted,
// or schema-qualified ("public"."users"), as drizzle-kit emits them.

export function loadMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => ({
      filename: `src/db/migrations/${filename}`,
      content: readFileSync(join(dir, filename), 'utf-8'),
    }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Identifier pattern accepting `name`, `"name"`, `schema.name`, `"schema"."name"`. */
function ident(name: string): string {
  const escaped = escapeRegExp(name);
  return `(?:"?[A-Za-z_][A-Za-z0-9_]*"?\\.)?"?${escaped}"?`;
}

function findCreateTableBody(content: string, table: string): string | null {
  const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ident(table)}\\s*\\(`, 'i');
  const m = re.exec(content);
  if (!m) return null;
  const openIdx = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = openIdx; i < content.length; i++) {
    const ch = content[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return content.slice(openIdx + 1, i);
    }
  }
  return null;
}

function findCreateEnumValues(content: string, enumName: string): string[] | null {
  const re = new RegExp(`CREATE\\s+TYPE\\s+${ident(enumName)}\\s+AS\\s+ENUM\\s*\\(([^)]*)\\)`, 'i');
  const m = re.exec(content);
  const body = m?.[1];
  if (body === undefined) return null;
  const values: string[] = [];
  const valueRe = /'((?:[^']|'')*)'/g;
  let vm: RegExpExecArray | null;
  while ((vm = valueRe.exec(body)) !== null) {
    values.push((vm[1] ?? '').replace(/''/g, "'"));
  }
  return values;
}

export function coversDrift(d: Drift, content: string): boolean {
  switch (d.kind) {
    case 'missing_table': {
      const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ident(d.table)}\\b`, 'i');
      return re.test(content);
    }
    case 'missing_column': {
      const addRe = new RegExp(
        `ALTER\\s+TABLE\\s+${ident(d.table)}\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ident(d.column)}\\b`,
        'i',
      );
      if (addRe.test(content)) return true;
      const body = findCreateTableBody(content, d.table);
      if (!body) return false;
      const colRe = new RegExp(`(^|,|\\s)"?${escapeRegExp(d.column)}"?\\s`, 'i');
      return colRe.test(body);
    }
    case 'nullability': {
      const setRe = new RegExp(
        `ALTER\\s+TABLE\\s+${ident(d.table)}\\s+ALTER\\s+COLUMN\\s+${ident(d.column)}\\s+SET\\s+NOT\\s+NULL`,
        'i',
      );
      if (setRe.test(content)) return true;
      const body = findCreateTableBody(content, d.table);
      if (!body) return false;
      const colDefRe = new RegExp(
        `(^|,|\\s)"?${escapeRegExp(d.column)}"?\\b[^,]*\\bNOT\\s+NULL\\b`,
        'i',
      );
      return colDefRe.test(body);
    }
    case 'missing_enum': {
      const re = new RegExp(`CREATE\\s+TYPE\\s+${ident(d.enum)}\\s+AS\\s+ENUM\\b`, 'i');
      return re.test(content);
    }
    case 'missing_enum_value': {
      const addRe = new RegExp(
        `ALTER\\s+TYPE\\s+${ident(d.enum)}\\s+ADD\\s+VALUE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'${escapeRegExp(d.value.replace(/'/g, "''"))}'`,
        'i',
      );
      if (addRe.test(content)) return true;
      const values = findCreateEnumValues(content, d.enum);
      return values !== null && values.includes(d.value);
    }
  }
}

export function classify(driftItems: Drift[], files: MigrationFile[]): Classified[] {
  return driftItems.map((drift) => ({
    drift,
    coveredBy: files.find((f) => coversDrift(drift, f.content)) ?? null,
  }));
}

/** Strict mode fails every drift item; lenient mode only uncovered ones. */
export function selectUnresolved(classified: Classified[], strict: boolean): Classified[] {
  return strict ? classified.slice() : classified.filter((c) => c.coveredBy === null);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function describeDrift(d: Drift): string {
  switch (d.kind) {
    case 'missing_table':
      return `table ${d.table}`;
    case 'missing_column':
      return `column ${d.table}.${d.column}`;
    case 'nullability':
      return `${d.table}.${d.column} is NOT NULL in schema but nullable in the database`;
    case 'missing_enum':
      return `enum ${d.enum}`;
    case 'missing_enum_value':
      return `enum value ${d.enum}.'${d.value}'`;
  }
}

function formatClassified(items: Classified[], strict: boolean): string {
  return items
    .map((c) => {
      const what = `${describeDrift(c.drift)}   [declared in ${c.drift.source}]`;
      if (c.coveredBy === null) {
        return `  ✗ drift:    ${what} — no committed migration covers this`;
      }
      return strict
        ? `  ✗ unapplied: ${what} — ${c.coveredBy.filename} is committed but not applied`
        : `  ✓ pending:  ${what} — will be added by ${c.coveredBy.filename}`;
    })
    .join('\n');
}

export function maskDatabaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<unparseable connection string>';
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const strict = process.argv.includes('--strict') || process.env.SCHEMA_DRIFT_STRICT === '1';

  const url = process.env.PROD_DATABASE_URL;
  if (!url) {
    console.error('schema-drift: PROD_DATABASE_URL is not set.');
    console.error('  This check targets production only and never falls back to DATABASE_URL.');
    console.error('  In CI, add the PROD_DATABASE_URL repository secret; locally, export it');
    console.error('  (a read-only role is sufficient) before running pnpm db:check-drift.');
    return 2;
  }

  console.log(`Mode:     ${strict ? 'STRICT (committed-but-unapplied migrations still fail)' : 'lenient (pending migrations tolerated)'}`);
  console.log(`Database: ${maskDatabaseUrl(url)}`);

  const declared = collectDeclared();
  console.log(`Declared: ${declared.tables.length} table(s), ${declared.enums.length} enum(s)`);

  const sql = postgres(url, { max: 1, connect_timeout: 15 });
  let live: Live;
  try {
    live = await introspect(sql);
  } catch (err) {
    console.error('schema-drift: failed to introspect the database:');
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    await sql.end({ timeout: 5 }).catch(() => undefined);
    return 2;
  }
  await sql.end({ timeout: 5 }).catch(() => undefined);

  console.log(`Live:     ${live.tables.size} table(s), ${live.enums.size} enum(s)`);

  const drift = diff(declared, live);
  if (drift.length === 0) {
    console.log('No drift detected. The database satisfies the declared schema.');
    return 0;
  }

  const files = loadMigrationFiles();
  const classified = classify(drift, files);
  const unresolved = selectUnresolved(classified, strict);
  const pending = classified.filter((c) => c.coveredBy !== null);

  console.log('');
  console.log(`DRIFT CHECK — ${drift.length} item(s) declared in the schema but missing from the database:`);
  console.log('');
  console.log(formatClassified(classified, strict));
  console.log('');

  if (unresolved.length === 0) {
    console.log(`Drift check passed (${pending.length} item(s) resolved by pending migrations).`);
    return 0;
  }

  const unapplied = unresolved.filter((c) => c.coveredBy !== null).length;
  console.error(`DRIFT DETECTED${strict ? ' (strict)' : ''} — ${unresolved.length} unresolved item(s).`);
  console.error('');
  if (unapplied > 0) {
    console.error(`${unapplied} of these are covered by a committed migration that has not been applied.`);
    console.error('To resolve: apply pending migrations against the production database');
    console.error('  (pnpm db:migrate with DATABASE_URL pointed at production, or your deploy');
    console.error('  pipeline\'s migrate step), then re-run this check.');
  }
  if (unapplied < unresolved.length) {
    console.error('Items with no covering migration: run pnpm db:generate, review the SQL,');
    console.error('  commit the migration file, and re-run this check.');
  }
  console.error('');
  console.error(`EXIT 1 — ${unresolved.length} unresolved drift item(s).`);
  return 1;
}

// Only run the database-touching CLI when invoked directly. Importing the
// module (for example to unit-test diff/classify) must not open a connection.
const invokedDirectly =
  typeof process.argv[1] === 'string' && /schema-drift(\.[cm]?[jt]s)?$/.test(process.argv[1]);

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error('schema-drift: unexpected error:');
      console.error(err);
      process.exit(2);
    },
  );
}
