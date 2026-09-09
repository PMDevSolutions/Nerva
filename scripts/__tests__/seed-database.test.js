/**
 * Tests for scripts/seed-database.sh
 *
 * A fake `npx` on PATH stands in for `npx tsx`: `tsx --version` succeeds
 * (unless `tsxMissing`), and `tsx src/db/seed.ts` records NODE_ENV in the log
 * and exits with `seedExit`. Environment files are written into the fixture.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { run, runBash, tmpProject, SCRIPTS_DIR } from "./helpers.js";

const SCRIPT = join(SCRIPTS_DIR, "seed-database.sh");
const DEV_URL = "postgres://user:s3cretpw@localhost:5432/app_dev";

let tmp;
let counter = 0;
beforeAll(() => {
  tmp = tmpProject("nerva-seed-");
});
afterAll(() => tmp.cleanup());

/**
 * Build an api/ fixture. `envFiles` maps ".env*" names to contents; `seed`
 * controls whether src/db/seed.ts exists. The returned env clears
 * DATABASE_URL so only the fixture's .env files (or `extraEnv`) supply it.
 */
function makeApi({ seed = true, envFiles = {}, seedExit = 0, tsxMissing = false, extraEnv = {} } = {}) {
  const name = `api-${counter++}`;
  const api = join(tmp.dir, name);
  mkdirSync(join(api, "src", "db"), { recursive: true });
  if (seed) writeFileSync(join(api, "src", "db", "seed.ts"), "console.log('seeding');\n");
  for (const [rel, content] of Object.entries(envFiles)) writeFileSync(join(api, rel), content);
  const bin = join(tmp.dir, `${name}-bin`);
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "calls.log");
  writeFileSync(
    join(bin, "npx"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "npx $*" >> "${log}"`,
      `if [[ "$1" == "tsx" && "$2" == "--version" ]]; then exit ${tsxMissing ? 1 : 0}; fi`,
      `printf '%s\\n' "NODE_ENV=${"$"}{NODE_ENV:-}" >> "${log}"`,
      `exit ${seedExit}`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "npx"), 0o755);
  const env = { NERVA_API_DIR: api, PATH: `${bin}:${process.env.PATH}`, DATABASE_URL: "", ...extraEnv };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { api, env, calls };
}

describe("seed-database.sh", () => {
  it("passes bash -n", () => {
    const r = run("bash", ["-n", SCRIPT]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("--env without a value exits 1", () => {
    const r = runBash(SCRIPT, ["--env"], { env: { NERVA_API_DIR: tmp.dir } });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ERROR] Missing value for --env.");
  });

  it("an invalid environment exits 1", () => {
    const r = runBash(SCRIPT, ["--env", "qa"], { env: { NERVA_API_DIR: tmp.dir } });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "[ERROR] Invalid environment: qa. Must be development, staging, or production.",
    );
  });

  it("an unknown option exits 1", () => {
    const r = runBash(SCRIPT, ["--force"], { env: { NERVA_API_DIR: tmp.dir } });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ERROR] Unknown option: --force");
  });

  it("exits 1 when the API directory is missing", () => {
    const missing = join(tmp.dir, "no-such-api");
    const r = runBash(SCRIPT, [], { env: { NERVA_API_DIR: missing } });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`[ERROR] API directory not found at: ${missing}`);
  });

  it("exits 1 when src/db/seed.ts is missing", () => {
    const { api, env, calls } = makeApi({ seed: false });
    const r = runBash(SCRIPT, [], { env });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`[ERROR] Seed file not found at: ${api}/src/db/seed.ts`);
    expect(calls()).toEqual([]);
  });

  it("refuses to seed production when stdin is not a terminal", () => {
    const { env, calls } = makeApi({ envFiles: { ".env.production": `DATABASE_URL=${DEV_URL}\n` } });
    const r = runBash(SCRIPT, ["--env", "production"], { env, input: "yes\n" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("[WARN] You are about to seed the PRODUCTION database!");
    expect(r.stderr).toContain("[ERROR] Cannot seed production in non-interactive mode.");
    expect(calls()).toEqual([]);
  });

  it("exits 1 when DATABASE_URL is unset and there is no .env file", () => {
    const { env, calls } = makeApi();
    const r = runBash(SCRIPT, [], { env });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("[WARN] No .env file found. Ensure DATABASE_URL is set.");
    expect(r.stderr).toContain("[ERROR] DATABASE_URL is not set.");
    expect(calls()).toEqual([]);
  });

  it("uses DATABASE_URL from the environment when no .env file exists", () => {
    const { env } = makeApi({ extraEnv: { DATABASE_URL: DEV_URL } });
    const r = runBash(SCRIPT, [], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[WARN] No .env file found.");
    expect(r.stdout).toContain("Database:    postgres://user:****@localhost:5432/app_dev");
  });

  describe("environment file resolution", () => {
    it(".env.development takes precedence over .env", () => {
      const { env } = makeApi({
        envFiles: {
          ".env": "DATABASE_URL=postgres://a:envpw@host/from_dotenv\n",
          ".env.development": "DATABASE_URL=postgres://b:devpw@host/from_dev\n",
        },
      });
      const r = runBash(SCRIPT, [], { env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("[INFO] Loading environment from: .env.development");
      expect(r.stdout).toContain("postgres://b:****@host/from_dev");
      expect(r.stdout).not.toContain("from_dotenv");
    });

    it("falls back to .env when .env.<env> is absent", () => {
      const { env } = makeApi({ envFiles: { ".env": `DATABASE_URL=${DEV_URL}\n` } });
      const r = runBash(SCRIPT, ["--env", "staging"], { env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("[INFO] Loading environment from: .env");
      expect(r.stdout).toContain("[INFO] Environment: staging");
    });

    it("--env staging loads .env.staging", () => {
      const { env } = makeApi({
        envFiles: {
          ".env": "DATABASE_URL=postgres://a:pw@host/dev\n",
          ".env.staging": "DATABASE_URL=postgres://a:pw@host/staging\n",
        },
      });
      const r = runBash(SCRIPT, ["--env", "staging"], { env });
      expect(r.stdout).toContain("[INFO] Loading environment from: .env.staging");
      expect(r.stdout).toContain("postgres://a:****@host/staging");
    });
  });

  it("masks the database password in output", () => {
    const { env } = makeApi({ envFiles: { ".env": `DATABASE_URL=${DEV_URL}\n` } });
    const r = runBash(SCRIPT, [], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Database:    postgres://user:****@localhost:5432/app_dev");
    expect(r.stdout + r.stderr).not.toContain("s3cretpw");
  });

  it("runs `npx tsx src/db/seed.ts` with NODE_ENV set to the target env", () => {
    const { env, calls } = makeApi({ envFiles: { ".env": `DATABASE_URL=${DEV_URL}\n` } });
    const r = runBash(SCRIPT, [], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[INFO] Running seed script...");
    expect(r.stdout).toMatch(/\[OK\] Database seeded in \d+s \(env: development\)\./);
    expect(calls()).toEqual(["npx tsx --version", "npx tsx src/db/seed.ts", "NODE_ENV=development"]);
  });

  it("passes NODE_ENV=staging for --env staging", () => {
    const { env, calls } = makeApi({ envFiles: { ".env": `DATABASE_URL=${DEV_URL}\n` } });
    const r = runBash(SCRIPT, ["--env", "staging"], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("(env: staging)");
    expect(calls()).toContain("NODE_ENV=staging");
  });

  it("exits 1 when tsx is unavailable", () => {
    const { env, calls } = makeApi({ tsxMissing: true, envFiles: { ".env": `DATABASE_URL=${DEV_URL}\n` } });
    const r = runBash(SCRIPT, [], { env });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ERROR] tsx is not available. Install with: pnpm add -D tsx");
    expect(calls()).toEqual(["npx tsx --version"]);
  });

  it("exits 1 with 'Seed script failed' when the seed exits non-zero", () => {
    const { env } = makeApi({ seedExit: 1, envFiles: { ".env": `DATABASE_URL=${DEV_URL}\n` } });
    const r = runBash(SCRIPT, [], { env });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/\[ERROR\] Seed script failed after \d+s\./);
    expect(r.stdout).not.toContain("Database seeded");
  });
});
