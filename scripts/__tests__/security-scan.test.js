/**
 * Tests for scripts/security-scan.sh
 *
 * Pattern detectors run against a fixture src/ tree (--patterns-only skips
 * `pnpm audit`). Audit behavior is tested with a fake `pnpm` on PATH whose
 * `audit` output is scripted and whose argv is logged.
 *
 * Regression notes: in text mode an issue without a file path (rate-limiting,
 * cors, logging, lockfile, dependency) once aborted the scan under `set -e`
 * because add_issue ended in `[[ -n "$file" ]] && echo`; and a zero-issue
 * --json run once crashed on bash 3.2 (macOS) by expanding an empty array
 * under `set -u`. Both are fixed and guarded here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { run, runBash, tmpProject, SCRIPTS_DIR } from "./helpers.js";

const SCRIPT = join(SCRIPTS_DIR, "security-scan.sh");

const CLEAN_INDEX = [
  'import { Hono } from "hono";',
  'import { cors } from "hono/cors";',
  'import { rateLimiter } from "./middleware/rate-limit";',
  "const app = new Hono();",
  'app.use("*", cors());',
  'app.use("*", rateLimiter());',
  "export default app;",
  "",
].join("\n");
const NO_RATELIMIT_INDEX = CLEAN_INDEX.split("\n").filter((l) => !/rateLimit/i.test(l)).join("\n");
const NO_CORS_INDEX = CLEAN_INDEX.split("\n").filter((l) => !/cors/i.test(l)).join("\n");
const NO_VULNS = "No known vulnerabilities found\n";

let tmp;
let counter = 0;
beforeAll(() => {
  tmp = tmpProject("nerva-secscan-");
});
afterAll(() => tmp.cleanup());

/**
 * Build an api/ fixture: `files` maps relative paths to contents, `lockfile`
 * writes pnpm-lock.yaml, `audit` is what the fake `pnpm audit` prints, and
 * `config` is exposed via NERVA_PIPELINE_CONFIG.
 */
function makeApi({ files = {}, lockfile = true, audit = NO_VULNS, config } = {}) {
  const name = `api-${counter++}`;
  const api = join(tmp.dir, name);
  mkdirSync(api, { recursive: true });
  if (lockfile) writeFileSync(join(api, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const [rel, content] of Object.entries(files)) {
    const full = join(api, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  const bin = join(tmp.dir, `${name}-bin`);
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "audit-output.txt"), audit);
  writeFileSync(
    join(bin, "pnpm"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "pnpm $*" >> "${log}"\ncat "${join(bin, "audit-output.txt")}"\nexit 0\n`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  const env = { NERVA_API_DIR: api, PATH: `${bin}:${process.env.PATH}` };
  if (config) {
    const cfg = join(tmp.dir, `${name}-config.json`);
    writeFileSync(cfg, JSON.stringify(config));
    env.NERVA_PIPELINE_CONFIG = cfg;
  }
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { api, env, calls };
}

/** --json prints [INFO] lines first; the report is the last line starting with "{". */
function parseReport(stdout) {
  const line = stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .pop();
  expect(line, "json report line").toBeDefined();
  return JSON.parse(line);
}

function scanJson(env, extra = []) {
  const r = runBash(SCRIPT, ["--patterns-only", "--json", ...extra], { env });
  return { ...r, report: parseReport(r.stdout) };
}

describe("security-scan.sh", () => {
  it("passes bash -n", () => {
    const r = run("bash", ["-n", SCRIPT]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("rejects unknown options with exit 1", () => {
    const r = runBash(SCRIPT, ["--bogus"], { env: { NERVA_API_DIR: tmp.dir } });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ERROR] Unknown option: --bogus");
  });

  it("exits 1 when the API directory is missing", () => {
    const missing = join(tmp.dir, "no-such-api");
    const r = runBash(SCRIPT, ["--patterns-only"], { env: { NERVA_API_DIR: missing } });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`[ERROR] API directory not found at: ${missing}`);
  });

  it("a clean fixture exits 0 with 'No issues found' and never calls pnpm", () => {
    const { env, calls } = makeApi({ files: { "src/index.ts": CLEAN_INDEX } });
    const r = runBash(SCRIPT, ["--patterns-only"], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Nerva Security Scan");
    expect(r.stdout).toContain("[OK] Security scan complete. No issues found.");
    expect(calls()).toEqual([]);
  });

  it("warns and exits 0 when there is no src/ directory", () => {
    const { env } = makeApi();
    const r = runBash(SCRIPT, ["--patterns-only"], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[WARN] No src/ directory found. Skipping pattern scan.");
  });

  describe("hardcoded secrets", () => {
    it("flags a password literal as CRITICAL with file:line and exits 1", () => {
      const { api, env } = makeApi({
        files: {
          "src/index.ts": CLEAN_INDEX,
          "src/config.ts": 'export const host = "db";\nconst password = "hunter22";\n',
        },
      });
      const r = runBash(SCRIPT, ["--patterns-only"], { env });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("[CRITICAL] Possible hardcoded secret");
      expect(r.stdout).toContain(`    File: ${join(api, "src", "config.ts")}:2`);
      expect(r.stdout).toContain("[WARN] Security scan complete. Found 1 issue(s).");
      expect(r.stdout).toContain("Run with --json for machine-readable output.");
    });

    it("flags JWT literals and Bearer tokens", () => {
      const { env } = makeApi({
        files: {
          "src/index.ts": CLEAN_INDEX,
          "src/auth.ts": [
            'const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";',
            'const headers = { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123" };',
            "export { jwt, headers };",
            "",
          ].join("\n"),
        },
      });
      const { exitCode, report } = scanJson(env);
      expect(exitCode).toBe(1);
      const secrets = report.issues.filter((i) => i.category === "hardcoded-secret");
      expect(secrets.map((i) => i.line).sort()).toEqual(["1", "2"]);
      for (const i of secrets) {
        expect(i.severity).toBe("critical");
        expect(i.file.endsWith("/src/auth.ts")).toBe(true);
      }
    });
  });

  describe("SQL interpolation", () => {
    it("flags template-literal interpolation in query/execute/raw as HIGH", () => {
      const { env } = makeApi({
        files: {
          "src/index.ts": CLEAN_INDEX,
          "src/repo.ts": [
            "export async function find(db, x) {",
            "  await db.execute(`SELECT * FROM users WHERE id = ${x}`);",
            "  await db.query(`DELETE FROM users WHERE id = ${x}`);",
            "  await db.execute(sql`SELECT 1`);",
            "}",
            "",
          ].join("\n"),
        },
      });
      const { exitCode, report } = scanJson(env);
      expect(exitCode).toBe(1);
      const sqlIssues = report.issues.filter((i) => i.category === "sql-injection");
      expect(sqlIssues.map((i) => i.line).sort()).toEqual(["2", "3"]);
      for (const i of sqlIssues) {
        expect(i.severity).toBe("high");
        expect(i.message).toBe("Possible SQL injection via string interpolation");
      }
    });
  });

  it("excludes .test.ts files from the secret and SQL scans", () => {
    const { env } = makeApi({
      files: {
        "src/index.ts": CLEAN_INDEX,
        "src/repo.test.ts":
          'const password = "hunter22";\ndb.execute(`SELECT ${x}`);\nconsole.log(password);\n',
      },
    });
    const r = runBash(SCRIPT, ["--patterns-only"], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No issues found");
  });

  describe("middleware and logging detectors (via --json)", () => {
    it("reports missing rate limiting", () => {
      const { env } = makeApi({ files: { "src/index.ts": NO_RATELIMIT_INDEX } });
      const { exitCode, report } = scanJson(env);
      expect(exitCode).toBe(1);
      expect(report.issues).toEqual([
        {
          severity: "medium",
          category: "rate-limiting",
          message: "No rate limiting middleware detected",
          file: "",
          line: "",
        },
      ]);
    });

    it("reports missing CORS", () => {
      const { env } = makeApi({ files: { "src/index.ts": NO_CORS_INDEX } });
      const { report } = scanJson(env);
      expect(report.issues_count).toBe(1);
      expect(report.issues[0]).toMatchObject({ severity: "medium", category: "cors" });
    });

    it("detects rate limiting and CORS declared in app.ts as well as index.ts", () => {
      const { env } = makeApi({ files: { "src/app.ts": CLEAN_INDEX, "src/index.ts": "export {};\n" } });
      const r = runBash(SCRIPT, ["--patterns-only"], { env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("No issues found");
    });

    it("counts console.log statements outside test files", () => {
      const { env } = makeApi({
        files: {
          "src/index.ts": CLEAN_INDEX,
          "src/service.ts": 'console.log("a");\nconsole.log("b");\n',
          "src/service.test.ts": 'console.log("ignored");\n',
        },
      });
      const { report } = scanJson(env);
      expect(report.issues_count).toBe(1);
      expect(report.issues[0]).toMatchObject({ severity: "low", category: "logging" });
      expect(report.issues[0].message).toMatch(/^Found\s+2 console\.log statement\(s\)/);
    });
  });

  it("--json emits a report with scan_date, issues_count and typed issue entries", () => {
    const { env } = makeApi({
      files: {
        "src/index.ts": NO_RATELIMIT_INDEX,
        "src/config.ts": 'const secret = "shh-very-secret";\n',
      },
    });
    const { report } = scanJson(env);
    expect(report.scan_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(report.issues_count).toBe(2);
    expect(report.issues).toHaveLength(2);
    for (const i of report.issues) {
      expect(["critical", "high", "medium", "low"]).toContain(i.severity);
      for (const k of ["category", "message", "file", "line"]) expect(typeof i[k]).toBe("string");
    }
    expect(report.issues.map((i) => i.category).sort()).toEqual(["hardcoded-secret", "rate-limiting"]);
  });

  describe("fail policy", () => {
    const SECRET_FILES = { "src/index.ts": CLEAN_INDEX, "src/config.ts": 'const password = "hunter22";\n' };

    it("--no-fail exits 0 even with issues", () => {
      const { env } = makeApi({ files: SECRET_FILES });
      const r = runBash(SCRIPT, ["--patterns-only", "--no-fail"], { env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Found 1 issue(s)");
      expect(r.stdout).toContain(
        "[WARN] Issues found but security.audit.failOnVulnerability is false (or --no-fail); exiting 0.",
      );
    });

    it("security.audit.failOnVulnerability=false in the config exits 0", () => {
      const { env } = makeApi({
        files: SECRET_FILES,
        config: { security: { audit: { failOnVulnerability: false } } },
      });
      const r = runBash(SCRIPT, ["--patterns-only"], { env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("exiting 0");
    });
  });

  describe("--audit-only (fake pnpm)", () => {
    it("succeeds when pnpm audit finds nothing and skips the pattern scan", () => {
      const { env, calls } = makeApi();
      const r = runBash(SCRIPT, ["--audit-only"], { env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("[INFO] Running pnpm audit for known vulnerabilities (level: moderate)...");
      expect(r.stdout).toContain("[OK] No known vulnerabilities in dependencies.");
      expect(r.stdout).toContain("No issues found");
      expect(r.stdout).not.toContain("Scanning for common API security anti-patterns");
      expect(calls()).toEqual(["pnpm audit --audit-level moderate"]);
    });

    it("--level is passed to pnpm audit and overrides security.audit.level", () => {
      const { env, calls } = makeApi({ config: { security: { audit: { level: "critical" } } } });
      runBash(SCRIPT, ["--audit-only"], { env });
      runBash(SCRIPT, ["--audit-only", "--level", "high"], { env });
      expect(calls()).toEqual(["pnpm audit --audit-level critical", "pnpm audit --audit-level high"]);
    });

    it("counts critical/high lines in the audit output as dependency issues", () => {
      const { env } = makeApi({
        audit: [
          "┌ critical │ Prototype Pollution in lodash",
          "┌ high     │ ReDoS in semver",
          "┌ high     │ Path traversal in tar",
          "",
        ].join("\n"),
      });
      const r = runBash(SCRIPT, ["--audit-only", "--json"], { env });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("[WARN] Vulnerabilities detected:");
      const report = parseReport(r.stdout);
      expect(report.issues).toEqual([
        { severity: "critical", category: "dependency", message: "1 critical vulnerability(ies)", file: "", line: "" },
        { severity: "high", category: "dependency", message: "2 high severity vulnerability(ies)", file: "", line: "" },
      ]);
    });

    it("flags a missing pnpm-lock.yaml as a medium lockfile issue", () => {
      const { env } = makeApi({ lockfile: false });
      const r = runBash(SCRIPT, ["--audit-only", "--json"], { env });
      expect(r.exitCode).toBe(1);
      const report = parseReport(r.stdout);
      expect(report.issues_count).toBe(1);
      expect(report.issues[0]).toMatchObject({ severity: "medium", category: "lockfile" });
      expect(report.issues[0].message).toContain("pnpm-lock.yaml is missing");
    });

    it("skips the lockfile check when security.audit.checkLockfile is false", () => {
      const { env } = makeApi({
        lockfile: false,
        config: { security: { audit: { checkLockfile: false } } },
      });
      const r = runBash(SCRIPT, ["--audit-only"], { env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain("pnpm-lock.yaml is missing");
      expect(r.stdout).toContain("No issues found");
    });
  });

  // Known bug (see header comment): text mode aborts on the first issue that
  // has no file path. Marked .fails so the suite flags it when the script is
  // fixed; flip to a regular test at that point.
  it("text mode prints the summary after a file-less issue", () => {
    const { env } = makeApi({ files: { "src/index.ts": NO_RATELIMIT_INDEX } });
    const r = runBash(SCRIPT, ["--patterns-only", "--no-fail"], { env });
    expect(r.stdout).toContain("[MEDIUM] No rate limiting middleware detected");
    expect(r.stdout).toContain("Security scan complete");
    expect(r.exitCode).toBe(0);
  });
});

describe("security-scan.sh --json with zero issues", () => {
  it("emits an empty issues array and exits 0 (bash 3.2 empty-array regression)", () => {
    const project = tmpProject("nerva-secscan-zero-");
    try {
      project.write("api/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
      project.write("api/src/index.ts", "import { cors } from 'hono/cors';\nimport { rateLimiter } from 'hono-rate-limiter';\n");
      const r = runBash(SCRIPT, ["--json", "--patterns-only"], {
        env: { NERVA_API_DIR: join(project.dir, "api") },
      });
      expect(r.exitCode).toBe(0);
      const json = JSON.parse(r.stdout.trim().split("\n").pop());
      expect(json.issues_count).toBe(0);
      expect(json.issues).toEqual([]);
    } finally {
      project.cleanup();
    }
  });
});
