#!/usr/bin/env node
/**
 * check-destructive-migrations.js — Fail (or warn) when a Drizzle migration
 * contains destructive DDL.
 *
 * Why
 * ---
 * Nerva migrations are additive by policy. A DROP/TRUNCATE in a committed
 * *.sql file usually means `drizzle-kit generate` ran against a database that
 * had drifted from the schema and emitted a "reconcile" plan — the kind of
 * migration that deletes production data when it is applied. This guard is a
 * pure static scan (no database needed) so it can run in CI, in a pre-commit
 * hook, and from scripts/generate-migration.sh right after a migration is
 * generated.
 *
 * What is flagged (after stripping -- and /* *\/ comments):
 *   DROP TABLE, DROP COLUMN, DROP CONSTRAINT, DROP NOT NULL, DROP TYPE,
 *   DROP SCHEMA, DROP INDEX, TRUNCATE, and DELETE FROM without a WHERE clause.
 *
 * Opting out
 * ----------
 * A reviewed, intentional destructive migration can allowlist itself with a
 * header comment (the reason is mandatory and shows up in the report):
 *
 *   -- nerva:allow-destructive: drops the legacy sessions table (moved to Redis in #42)
 *
 * Usage
 * -----
 *   node scripts/check-destructive-migrations.js [--dir <path>] [--json] [--warn-only]
 *
 *   --dir <path>   Migrations directory. Default: the first existing of
 *                  ./src/db/migrations, ./api/src/db/migrations, ./drizzle,
 *                  $NERVA_API_DIR/src/db/migrations.
 *   --json         Machine-readable report on stdout.
 *   --warn-only    Report findings but exit 0.
 *   --help         Show this help.
 *
 * Blocking mode is read from database.blockDestructiveMigrations in
 * .claude/pipeline.config.json when this script runs inside the Nerva
 * framework repo (default true). When copied standalone into a generated
 * project (api/scripts/check-destructive-migrations.mjs) it has no config and
 * blocks by default; use --warn-only to soften it.
 *
 * Exit codes: 0 clean (or warn-only), 1 destructive findings, 2 usage/IO error.
 *
 * The pure helpers (stripSqlComments, scanSql, parseAllowlistReason, ...) are
 * exported for tests; main() only runs when the file is invoked directly.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Destructive tokens, matched against comment-stripped SQL. */
export const DESTRUCTIVE_PATTERNS = Object.freeze([
  { label: "DROP TABLE", re: /\bDROP\s+TABLE\b/gi },
  { label: "DROP COLUMN", re: /\bDROP\s+COLUMN\b/gi },
  { label: "DROP CONSTRAINT", re: /\bDROP\s+CONSTRAINT\b/gi },
  { label: "DROP NOT NULL", re: /\bDROP\s+NOT\s+NULL\b/gi },
  { label: "DROP TYPE", re: /\bDROP\s+TYPE\b/gi },
  { label: "DROP SCHEMA", re: /\bDROP\s+SCHEMA\b/gi },
  { label: "DROP INDEX", re: /\bDROP\s+INDEX\b/gi },
  { label: "TRUNCATE", re: /\bTRUNCATE\b/gi },
]);

export const DELETE_WITHOUT_WHERE_LABEL = "DELETE FROM without WHERE";
export const INVALID_ALLOWLIST_LABEL = "allow-destructive marker without a reason";

export const ALLOWLIST_MARKER = "nerva:allow-destructive:";
const ALLOWLIST_LINE_RE = /^[ \t]*--[ \t]*nerva:allow-destructive:(.*)$/im;

export const DEFAULT_DIR_CANDIDATES = Object.freeze([
  "src/db/migrations",
  "api/src/db/migrations",
  "drizzle",
]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Remove SQL comments while preserving string literals and line structure.
 *
 * - `-- ...` line comments and `/* ... *\/` block comments (nesting allowed)
 *   are replaced by whitespace; newlines inside block comments are kept so
 *   line numbers in findings stay accurate.
 * - Single-quoted strings ('' escapes a quote) and dollar-quoted strings
 *   ($$ ... $$ or $tag$ ... $tag$) are copied verbatim, so a `--` inside a
 *   literal never starts a comment.
 */
export function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "'") {
      out += ch;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (ch === "-" && next === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      out += " ";
      i = j;
      continue;
    }

    if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      let newlines = "";
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          if (sql[j] === "\n") newlines += "\n";
          j++;
        }
      }
      out += " " + newlines;
      i = j;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Split (comment-stripped) SQL into top-level statements on `;`, honoring
 * single-quoted and dollar-quoted strings. Returns { text, offset } pairs so
 * callers can map findings back to line numbers. Dollar-quoted bodies (DO
 * blocks, function bodies) are also returned as nested statements so a
 * DELETE hidden inside `DO $$ ... $$` is still inspected.
 */
export function splitStatements(sql) {
  const statements = [];
  const nestedBodies = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const bodyStart = i + tag.length;
        const bodyEnd = end === -1 ? n : end;
        nestedBodies.push({ text: sql.slice(bodyStart, bodyEnd), offset: bodyStart });
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    if (ch === ";") {
      statements.push({ text: sql.slice(start, i), offset: start });
      start = i + 1;
    }
    i++;
  }
  if (start < n) statements.push({ text: sql.slice(start), offset: start });

  for (const body of nestedBodies) {
    for (const nested of splitStatements(body.text)) {
      statements.push({ text: nested.text, offset: body.offset + nested.offset });
    }
  }
  return statements;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

function excerptAround(text, index, before = 30, after = 50) {
  const start = Math.max(0, index - before);
  return text
    .slice(start, index + after)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Scan one migration's SQL text. Returns findings of the shape
 * { file, label, line, excerpt }. Comments are stripped first so prose that
 * mentions "DROP TABLE" never trips the guard.
 */
export function scanSql(file, sqlText) {
  const stripped = stripSqlComments(sqlText);
  const findings = [];

  for (const { label, re } of DESTRUCTIVE_PATTERNS) {
    const regex = new RegExp(re.source, re.flags);
    let m;
    while ((m = regex.exec(stripped)) !== null) {
      findings.push({
        file,
        label,
        line: lineOf(stripped, m.index),
        excerpt: excerptAround(stripped, m.index),
      });
    }
  }

  for (const stmt of splitStatements(stripped)) {
    // Statements inside DO/function bodies may start with BEGIN.
    const m = /^\s*(?:BEGIN\s+)?(DELETE\s+FROM)\b/i.exec(stmt.text);
    if (!m) continue;
    if (/\bWHERE\b/i.test(stmt.text)) continue;
    const index = stmt.offset + m.index + m[0].length - m[1].length;
    findings.push({
      file,
      label: DELETE_WITHOUT_WHERE_LABEL,
      line: lineOf(stripped, index),
      excerpt: stmt.text.replace(/\s+/g, " ").trim().slice(0, 80),
    });
  }

  findings.sort((a, b) => a.line - b.line || a.label.localeCompare(b.label));
  return findings;
}

/** True when the file carries a `-- nerva:allow-destructive:` line at all. */
export function hasAllowlistMarker(sqlText) {
  return ALLOWLIST_LINE_RE.test(sqlText);
}

/**
 * Return the allowlist reason from a `-- nerva:allow-destructive: <reason>`
 * comment line, or null when the marker is absent or its reason is empty.
 */
export function parseAllowlistReason(sqlText) {
  const m = ALLOWLIST_LINE_RE.exec(sqlText);
  if (!m) return null;
  const reason = (m[1] ?? "").trim();
  return reason.length > 0 ? reason : null;
}

export function listMigrationFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".sql"))
    .sort();
}

/**
 * Scan a directory of migrations. Returns a report object:
 * { dir, files, scanned, skipped: [{file, reason}], findings: [...] }
 */
export function scanDirectory(dir) {
  const files = listMigrationFiles(dir);
  const skipped = [];
  const findings = [];

  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    const reason = parseAllowlistReason(text);
    if (reason !== null) {
      skipped.push({ file, reason });
      continue;
    }
    if (hasAllowlistMarker(text)) {
      findings.push({
        file,
        label: INVALID_ALLOWLIST_LABEL,
        line: lineOf(text, text.search(ALLOWLIST_LINE_RE)),
        excerpt: `-- ${ALLOWLIST_MARKER} <reason is required>`,
      });
    }
    findings.push(...scanSql(file, text));
  }

  return { dir, files, scanned: files.length - skipped.length, skipped, findings };
}

// ---------------------------------------------------------------------------
// Directory + config resolution
// ---------------------------------------------------------------------------

export function resolveMigrationsDir(explicitDir, cwd = process.cwd(), env = process.env) {
  if (explicitDir) return resolve(cwd, explicitDir);
  const candidates = DEFAULT_DIR_CANDIDATES.map((c) => resolve(cwd, c));
  if (env.NERVA_API_DIR) candidates.push(resolve(env.NERVA_API_DIR, "src/db/migrations"));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

/**
 * Read database.blockDestructiveMigrations from pipeline.config.json via
 * scripts/lib/pipeline-config.js when that helper sits next to this script.
 * Standalone copies (generated projects) have no helper and default to true.
 */
export async function readBlockingFromConfig(defaultValue = true) {
  const helperUrl = new URL("./lib/pipeline-config.js", import.meta.url);
  let helperPath;
  try {
    helperPath = fileURLToPath(helperUrl);
  } catch {
    return defaultValue;
  }
  if (!existsSync(helperPath)) return defaultValue;
  try {
    const mod = await import(helperUrl.href);
    if (typeof mod.getValue !== "function") return defaultValue;
    const value = mod.getValue("database.blockDestructiveMigrations", defaultValue);
    if (typeof value === "boolean") return value;
    if (value === "false") return false;
    if (value === "true") return true;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node check-destructive-migrations.js [--dir <path>] [--json] [--warn-only]

Scans *.sql migration files for destructive DDL (DROP TABLE/COLUMN/CONSTRAINT/
NOT NULL/TYPE/SCHEMA/INDEX, TRUNCATE, DELETE FROM without WHERE).

Options:
  --dir <path>   Migrations directory (default: first existing of
                 ./src/db/migrations, ./api/src/db/migrations, ./drizzle,
                 $NERVA_API_DIR/src/db/migrations)
  --json         Print a JSON report to stdout
  --warn-only    Report findings but exit 0
  --help, -h     Show this help

Allowlist a reviewed destructive migration by adding a header comment line:
  -- ${ALLOWLIST_MARKER} <reason>

Exit codes: 0 clean or warn-only, 1 destructive findings, 2 usage/IO error.`;

export function parseArgs(argv) {
  const opts = { dir: null, json: false, warnOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--dir requires a path");
      opts.dir = value;
      i++;
    } else if (arg.startsWith("--dir=")) {
      opts.dir = arg.slice("--dir=".length);
      if (!opts.dir) throw new Error("--dir requires a path");
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--warn-only") {
      opts.warnOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function printTextReport(report, blocking) {
  const { dir, files, skipped, findings } = report;
  console.log(
    `Scanned ${report.scanned} of ${files.length} migration file(s) in ${dir} (${skipped.length} allowlisted, skipped).`,
  );
  for (const s of skipped) {
    console.log(`  ⊘ ${s.file}: allowlisted — ${s.reason}`);
  }

  if (findings.length === 0) {
    console.log("  ✓ No destructive DDL found in migrations.");
    return;
  }

  const stream = blocking ? console.error : console.log;
  stream("");
  stream(`  ✗ Destructive DDL found in ${new Set(findings.map((f) => f.file)).size} migration file(s):`);
  stream("");
  for (const f of findings) {
    stream(`  ${f.file}:${f.line}  ${f.label}  …${f.excerpt}…`);
  }
  stream("");
  stream(
    [
      "Migrations are expected to be additive. A DROP/TRUNCATE usually means",
      "`drizzle-kit generate` ran against a drifted database and emitted a",
      "reconcile plan; do not apply it. If the destructive change is intended and",
      "reviewed, allowlist the file by adding a header comment line:",
      "",
      `  -- ${ALLOWLIST_MARKER} <why this destructive change is safe>`,
      "",
      blocking
        ? "Blocking (database.blockDestructiveMigrations=true); use --warn-only to report without failing."
        : "Not blocking (warn-only); findings reported for review.",
    ].join("\n"),
  );
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`check-destructive-migrations: ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const dir = resolveMigrationsDir(opts.dir);
  if (!dir) {
    console.error(
      "check-destructive-migrations: no migrations directory found. Pass --dir <path> or run from a project containing " +
        DEFAULT_DIR_CANDIDATES.join(", ") +
        ".",
    );
    return 2;
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`check-destructive-migrations: migrations directory not found: ${dir}`);
    return 2;
  }

  let report;
  try {
    report = scanDirectory(dir);
  } catch (err) {
    console.error(`check-destructive-migrations: failed to read ${dir}: ${err.message}`);
    return 2;
  }

  const blocking = opts.warnOnly ? false : await readBlockingFromConfig(true);
  const ok = report.findings.length === 0;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok,
          blocking,
          dir: report.dir,
          scanned: report.scanned,
          files: report.files,
          skipped: report.skipped,
          findings: report.findings,
        },
        null,
        2,
      ),
    );
  } else {
    printTextReport(report, blocking);
  }

  if (ok) return 0;
  return blocking ? 1 : 0;
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  (resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    basename(process.argv[1]) === basename(fileURLToPath(import.meta.url)));

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`check-destructive-migrations: unexpected error: ${err?.stack ?? err}`);
      process.exit(2);
    },
  );
}
