/**
 * Tests for scripts/run-tests.sh
 *
 * The script shells out to `npx vitest run`; a fake `npx` on PATH records its
 * argv so flag translation can be asserted without installing vitest in the
 * fixture. Thresholds come from NERVA_PIPELINE_CONFIG.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { run, runBash, tmpProject, SCRIPTS_DIR } from "./helpers.js";

const SCRIPT = join(SCRIPTS_DIR, "run-tests.sh");
const UNIT_GLOBS = "--include tests/unit/**/*.{test,spec}.ts --include src/**/*.{test,spec}.ts";
const INTEGRATION_GLOB = "--include tests/integration/**/*.{test,spec}.ts";

let tmp;
let counter = 0;
beforeAll(() => {
  tmp = tmpProject("nerva-runtests-");
});
afterAll(() => tmp.cleanup());

/**
 * Build an api/ fixture with node_modules plus a fake `npx` that appends its
 * argv to a log and exits with `npxExit`. `config` (object) is written to a
 * temp file and exposed through NERVA_PIPELINE_CONFIG; `coverage` (object) is
 * written to coverage/coverage-summary.json.
 */
function makeApi({ npxExit = 0, config, coverage, nodeModules = true } = {}) {
  const name = `api-${counter++}`;
  const api = join(tmp.dir, name);
  mkdirSync(api, { recursive: true });
  if (nodeModules) mkdirSync(join(api, "node_modules"), { recursive: true });
  if (coverage) {
    mkdirSync(join(api, "coverage"), { recursive: true });
    writeFileSync(join(api, "coverage", "coverage-summary.json"), JSON.stringify(coverage));
  }
  const bin = join(tmp.dir, `${name}-bin`);
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "calls.log");
  writeFileSync(
    join(bin, "npx"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "npx $*" >> "${log}"\nexit ${npxExit}\n`,
  );
  chmodSync(join(bin, "npx"), 0o755);
  const env = { NERVA_API_DIR: api, PATH: `${bin}:${process.env.PATH}` };
  if (config) {
    const cfg = join(tmp.dir, `${name}-config.json`);
    writeFileSync(cfg, JSON.stringify(config));
    env.NERVA_PIPELINE_CONFIG = cfg;
  }
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { api, env, calls };
}

describe("run-tests.sh", () => {
  it("passes bash -n", () => {
    const r = run("bash", ["-n", SCRIPT]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 1 when the API directory is missing", () => {
    const missing = join(tmp.dir, "no-such-api");
    const r = runBash(SCRIPT, [], { env: { NERVA_API_DIR: missing } });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ERROR] API directory not found at:");
    expect(r.stderr).toContain(missing);
  });

  it("exits 1 when node_modules is missing", () => {
    const { env, calls } = makeApi({ nodeModules: false });
    const r = runBash(SCRIPT, [], { env });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Dependencies not installed. Run pnpm install first.");
    expect(calls()).toEqual([]);
  });

  it("default mode runs `npx vitest run` and reports success", () => {
    const { env, calls } = makeApi();
    const r = runBash(SCRIPT, [], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[INFO] Running all tests...");
    expect(r.stdout).toContain("Command: npx vitest run\n");
    expect(r.stdout).toMatch(/\[OK\] Tests passed in \d+s\./);
    expect(calls()).toEqual(["npx vitest run"]);
  });

  it("--unit adds the unit include globs", () => {
    const { env, calls } = makeApi();
    const r = runBash(SCRIPT, ["--unit"], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[INFO] Running unit tests...");
    expect(calls()).toEqual([`npx vitest run ${UNIT_GLOBS}`]);
  });

  it("--integration adds the integration glob and --testTimeout from testing.integrationTimeout", () => {
    const { env, calls } = makeApi({ config: { testing: { integrationTimeout: 12345 } } });
    const r = runBash(SCRIPT, ["--integration"], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[INFO] Running integration tests...");
    expect(calls()).toEqual([`npx vitest run ${INTEGRATION_GLOB} --testTimeout 12345`]);
  });

  it("--integration falls back to the repo pipeline.config.json timeout", () => {
    const { env, calls } = makeApi();
    runBash(SCRIPT, ["--integration"], { env });
    expect(calls()[0]).toContain("--testTimeout 30000");
  });

  it("--coverage adds --coverage to the vitest command", () => {
    const { env, calls } = makeApi();
    const r = runBash(SCRIPT, ["--coverage"], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[INFO] Coverage reporting enabled.");
    expect(calls()).toEqual(["npx vitest run --coverage"]);
    // No summary file: nothing to enforce, no threshold messages.
    expect(r.stdout).not.toContain("threshold");
  });

  it("--watch and args after `--` reach vitest in order", () => {
    const { env, calls } = makeApi();
    const r = runBash(SCRIPT, ["--unit", "--watch", "--", "--reporter", "dot", "--bail", "1"], {
      env,
    });
    expect(r.exitCode).toBe(0);
    expect(calls()).toEqual([`npx vitest run ${UNIT_GLOBS} --watch --reporter dot --bail 1`]);
  });

  it("unrecognized arguments before `--` are passed through as-is", () => {
    const { env, calls } = makeApi();
    runBash(SCRIPT, ["tests/unit/users.test.ts", "-t", "creates"], { env });
    expect(calls()).toEqual(["npx vitest run tests/unit/users.test.ts -t creates"]);
  });

  it("exits 1 with 'Tests failed' when vitest fails", () => {
    const { env } = makeApi({ npxExit: 1 });
    const r = runBash(SCRIPT, [], { env });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/\[ERROR\] Tests failed after \d+s\./);
    expect(r.stdout).not.toContain("Tests passed");
  });

  describe("coverage gate (tdd.coverageThreshold)", () => {
    it("fails when line coverage is below the threshold", () => {
      const { env } = makeApi({
        config: { tdd: { coverageThreshold: 80 } },
        coverage: { total: { lines: { pct: 72.5 } } },
      });
      const r = runBash(SCRIPT, ["--coverage"], { env });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("[INFO] Coverage report generated at:");
      expect(r.stderr).toContain(
        "[ERROR] Line coverage 72.5% is below the 80% threshold (tdd.coverageThreshold).",
      );
    });

    it("passes when line coverage meets the threshold", () => {
      const { env } = makeApi({
        config: { tdd: { coverageThreshold: 80 } },
        coverage: { total: { lines: { pct: 91 } } },
      });
      const r = runBash(SCRIPT, ["--coverage"], { env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(
        "[OK] Line coverage 91% meets the 80% threshold (tdd.coverageThreshold).",
      );
    });

    it("reads the threshold from the config, not a hardcoded 80", () => {
      const { env } = makeApi({
        config: { tdd: { coverageThreshold: 95 } },
        coverage: { total: { lines: { pct: 91 } } },
      });
      const r = runBash(SCRIPT, ["--coverage"], { env });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Line coverage 91% is below the 95% threshold");
    });

    it("warns and exits 0 when the summary lacks total.lines", () => {
      const { env } = makeApi({
        config: { tdd: { coverageThreshold: 80 } },
        coverage: { total: { statements: { pct: 10 } } },
      });
      const r = runBash(SCRIPT, ["--coverage"], { env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(
        "[WARN] Could not read total line coverage from coverage-summary.json; threshold not enforced.",
      );
    });

    it("is not applied without --coverage even when a summary exists", () => {
      const { env } = makeApi({
        config: { tdd: { coverageThreshold: 80 } },
        coverage: { total: { lines: { pct: 5 } } },
      });
      const r = runBash(SCRIPT, [], { env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain("threshold");
    });
  });
});
