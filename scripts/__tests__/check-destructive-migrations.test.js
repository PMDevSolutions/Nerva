import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { realpathSync } from "fs";
import { runNode, tmpProject, SCRIPTS_DIR } from "./helpers.js";
import {
  stripSqlComments,
  scanSql,
  parseAllowlistReason,
  hasAllowlistMarker,
  splitStatements,
  DELETE_WITHOUT_WHERE_LABEL,
  INVALID_ALLOWLIST_LABEL,
} from "../check-destructive-migrations.js";

const SCRIPT = join(SCRIPTS_DIR, "check-destructive-migrations.js");

/** Run the CLI with a pipeline config that pins blockDestructiveMigrations. */
function runCheck(project, args, { block = true } = {}) {
  const configPath = project.write(
    `pipeline.${block}.json`,
    JSON.stringify({ database: { blockDestructiveMigrations: block } }),
  );
  return runNode(SCRIPT, args, {
    cwd: project.dir,
    env: { NERVA_PIPELINE_CONFIG: configPath },
  });
}

describe("stripSqlComments", () => {
  it("removes line and block comments but keeps string literals", () => {
    const sql = [
      "-- DROP TABLE prose",
      "INSERT INTO t VALUES ('-- not a comment', '/* nor this */'); /* DROP COLUMN x */",
      "SELECT 1;",
    ].join("\n");
    const out = stripSqlComments(sql);
    expect(out).not.toContain("DROP TABLE");
    expect(out).not.toContain("DROP COLUMN");
    expect(out).toContain("'-- not a comment'");
    expect(out).toContain("'/* nor this */'");
    expect(out).toContain("SELECT 1;");
  });

  it("preserves line numbers across multi-line block comments", () => {
    const sql = "/* a\nb\nc */\nSELECT 1;";
    expect(stripSqlComments(sql).split("\n").length).toBe(sql.split("\n").length);
  });

  it("keeps dollar-quoted bodies intact", () => {
    const sql = "DO $$ BEGIN -- keep\nEND $$;";
    expect(stripSqlComments(sql)).toContain("-- keep");
  });
});

describe("splitStatements", () => {
  it("splits on semicolons outside of string literals and descends into DO bodies", () => {
    const stmts = splitStatements("SELECT 'a;b'; DO $$ BEGIN DELETE FROM c; END $$; SELECT 2");
    const texts = stmts.map((s) => s.text.trim());
    expect(texts).toContain("SELECT 'a;b'");
    expect(texts).toContain("SELECT 2");
    expect(texts.some((t) => /DELETE FROM c/.test(t))).toBe(true);
  });
});

describe("scanSql", () => {
  const cases = [
    ["DROP TABLE", 'DROP TABLE "users";'],
    ["DROP TABLE", 'DROP TABLE IF EXISTS "users" CASCADE;'],
    ["DROP COLUMN", 'ALTER TABLE "users" DROP COLUMN "email";'],
    ["DROP CONSTRAINT", 'ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";'],
    ["DROP NOT NULL", 'ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL;'],
    ["DROP TYPE", 'DROP TYPE "role";'],
    ["DROP SCHEMA", 'DROP SCHEMA "tenant_acme" CASCADE;'],
    ["DROP INDEX", 'DROP INDEX "users_email_idx";'],
    ["TRUNCATE", 'TRUNCATE TABLE "sessions";'],
    [DELETE_WITHOUT_WHERE_LABEL, 'DELETE FROM "sessions";'],
  ];

  it.each(cases)("flags %s", (label, sql) => {
    const findings = scanSql("x.sql", sql);
    expect(findings.map((f) => f.label)).toContain(label);
    expect(findings[0].file).toBe("x.sql");
    expect(findings[0].line).toBe(1);
  });

  it("flags every destructive statement, case-insensitively, with line numbers", () => {
    const sql = 'CREATE TABLE "a" ("id" serial);\ndrop table "b";\nALTER TABLE "c" drop column "x";';
    const findings = scanSql("multi.sql", sql);
    expect(findings.map((f) => [f.label, f.line])).toEqual([
      ["DROP TABLE", 2],
      ["DROP COLUMN", 3],
    ]);
  });

  it("does not flag destructive keywords that appear only in comments", () => {
    const sql = [
      "-- DROP TABLE legacy",
      "/* ALTER TABLE x DROP COLUMN y;",
      "   TRUNCATE z; DELETE FROM q; */",
      'ALTER TABLE "users" ADD COLUMN "nickname" text;',
    ].join("\n");
    expect(scanSql("comments.sql", sql)).toEqual([]);
  });

  it("does not flag DELETE FROM with a WHERE clause", () => {
    expect(scanSql("d.sql", "DELETE FROM sessions WHERE expires_at < now();")).toEqual([]);
  });

  it("flags DELETE FROM without WHERE inside a DO block", () => {
    const findings = scanSql("do.sql", "DO $$ BEGIN\n  DELETE FROM sessions;\nEND $$;");
    expect(findings.map((f) => f.label)).toEqual([DELETE_WITHOUT_WHERE_LABEL]);
    expect(findings[0].line).toBe(2);
  });

  it("is clean for additive migrations", () => {
    const sql = [
      'CREATE TYPE "public"."role" AS ENUM(\'admin\', \'user\');',
      'CREATE TABLE "users" ("id" uuid PRIMARY KEY, "role" "role" NOT NULL);',
      'ALTER TABLE "users" ADD COLUMN "nickname" text;',
      'CREATE INDEX "users_role_idx" ON "users" ("role");',
      'ALTER TABLE "users" ALTER COLUMN "nickname" SET NOT NULL;',
    ].join("\n");
    expect(scanSql("clean.sql", sql)).toEqual([]);
  });
});

describe("parseAllowlistReason", () => {
  it("returns the reason from a header marker", () => {
    const sql = "-- nerva:allow-destructive: drops the legacy sessions table (moved to Redis)\nDROP TABLE sessions;";
    expect(parseAllowlistReason(sql)).toBe("drops the legacy sessions table (moved to Redis)");
    expect(hasAllowlistMarker(sql)).toBe(true);
  });

  it("tolerates spacing variants", () => {
    expect(parseAllowlistReason("--nerva:allow-destructive:reason here\n")).toBe("reason here");
    expect(parseAllowlistReason("  --   nerva:allow-destructive:   spaced   \n")).toBe("spaced");
  });

  it("rejects a marker without a reason", () => {
    expect(parseAllowlistReason("-- nerva:allow-destructive:\nDROP TABLE x;")).toBeNull();
    expect(parseAllowlistReason("-- nerva:allow-destructive:    \nDROP TABLE x;")).toBeNull();
    expect(hasAllowlistMarker("-- nerva:allow-destructive:\n")).toBe(true);
  });

  it("returns null when no marker is present", () => {
    expect(parseAllowlistReason("DROP TABLE x;")).toBeNull();
    expect(hasAllowlistMarker("DROP TABLE x;")).toBe(false);
  });

  it("ignores the marker outside a comment line", () => {
    expect(parseAllowlistReason("INSERT INTO t VALUES ('nerva:allow-destructive: nope');")).toBeNull();
  });
});

describe("CLI", () => {
  let project;

  beforeAll(() => {
    project = tmpProject("nerva-destructive-");
    project.write("clean/0000_init.sql", 'CREATE TABLE "users" ("id" serial PRIMARY KEY);\n');
    project.write(
      "clean/0001_add.sql",
      '-- DROP TABLE mentioned in prose only\nALTER TABLE "users" ADD COLUMN "email" text;\n',
    );

    project.write("bad/0000_init.sql", 'CREATE TABLE "users" ("id" serial PRIMARY KEY);\n');
    project.write("bad/0001_drop.sql", 'ALTER TABLE "users" DROP COLUMN "email";\nTRUNCATE "audit";\n');

    project.write(
      "allowed/0000_drop.sql",
      '-- nerva:allow-destructive: legacy table replaced by KV cache in #42\nDROP TABLE "legacy";\n',
    );

    project.write("noreason/0000_drop.sql", '-- nerva:allow-destructive:\nDROP TABLE "legacy";\n');

    project.write("empty/.keep", "");
  });

  afterAll(() => project.cleanup());

  it("exits 0 on a clean directory and reports the scan", () => {
    const r = runCheck(project, ["--dir", "clean"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Scanned 2 of 2 migration file(s)");
    expect(r.stdout).toContain("No destructive DDL found");
  });

  it("exits 0 on a directory with no .sql files", () => {
    const r = runCheck(project, ["--dir", "empty"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Scanned 0 of 0");
  });

  it("exits 1 with findings and allowlist instructions when blocking", () => {
    const r = runCheck(project, ["--dir", "bad"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("0001_drop.sql:1  DROP COLUMN");
    expect(r.stderr).toContain("0001_drop.sql:2  TRUNCATE");
    expect(r.stderr).toContain("-- nerva:allow-destructive:");
  });

  it("exits 0 with findings when --warn-only", () => {
    const r = runCheck(project, ["--dir", "bad", "--warn-only"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("DROP COLUMN");
    expect(r.stdout).toContain("Not blocking (warn-only)");
  });

  it("exits 0 with findings when the pipeline config disables blocking", () => {
    const r = runCheck(project, ["--dir", "bad"], { block: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("DROP COLUMN");
  });

  it("skips allowlisted files and reports the reason", () => {
    const r = runCheck(project, ["--dir", "allowed"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1 allowlisted, skipped");
    expect(r.stdout).toContain("0000_drop.sql: allowlisted — legacy table replaced by KV cache in #42");
  });

  it("rejects an allowlist marker without a reason", () => {
    const r = runCheck(project, ["--dir", "noreason"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(INVALID_ALLOWLIST_LABEL);
    expect(r.stderr).toContain("DROP TABLE");
  });

  it("emits a JSON report with --json", () => {
    const r = runCheck(project, ["--dir", "bad", "--json"]);
    expect(r.exitCode).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({
      ok: false,
      blocking: true,
      scanned: 2,
      files: ["0000_init.sql", "0001_drop.sql"],
      skipped: [],
    });
    // macOS tmpdir is a symlink (/var -> /private/var); the child resolves it.
    expect(report.dir).toBe(realpathSync(join(project.dir, "bad")));
    expect(report.findings).toHaveLength(2);
    expect(report.findings[0]).toEqual({
      file: "0001_drop.sql",
      label: "DROP COLUMN",
      line: 1,
      excerpt: expect.stringContaining("DROP COLUMN"),
    });
  });

  it("JSON report lists allowlisted files under skipped", () => {
    const r = runCheck(project, ["--dir", "allowed", "--json"]);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(true);
    expect(report.skipped).toEqual([
      { file: "0000_drop.sql", reason: "legacy table replaced by KV cache in #42" },
    ]);
  });

  it("exits 2 when the migrations directory is missing", () => {
    const r = runCheck(project, ["--dir", "does-not-exist"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("migrations directory not found");
  });

  it("exits 2 when no default directory can be resolved", () => {
    const r = runNode(SCRIPT, [], { cwd: join(project.dir, "empty"), env: { NERVA_API_DIR: "" } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("no migrations directory found");
  });

  it("resolves the default directory from NERVA_API_DIR", () => {
    project.write("apiroot/src/db/migrations/0000_init.sql", 'CREATE TABLE "t" ("id" serial);\n');
    const r = runNode(SCRIPT, [], {
      cwd: join(project.dir, "empty"),
      env: { NERVA_API_DIR: join(project.dir, "apiroot") },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Scanned 1 of 1");
  });

  it("exits 2 on an unknown option and prints usage", () => {
    const r = runCheck(project, ["--bogus"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Unknown option: --bogus");
    expect(r.stderr).toContain("Usage:");
  });

  it("prints help with --help", () => {
    const r = runNode(SCRIPT, ["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("nerva:allow-destructive:");
  });
});
