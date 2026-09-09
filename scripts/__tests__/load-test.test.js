/**
 * Tests for scripts/load-test.sh
 *
 * A fake `k6` on PATH logs its argv and exits with a chosen code, so the
 * generated baseline script, config-driven defaults, and flag translation can
 * be asserted without k6 or a running API.
 *
 * Regression note: a successful run without --json once exited 1 because the
 * script's last statement was `[[ "$OUTPUT_JSON" == true ]] && info ...`;
 * the final test guards that exit code.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { run, runBash, tmpProject, SCRIPTS_DIR } from "./helpers.js";

const SCRIPT = join(SCRIPTS_DIR, "load-test.sh");
const TUNED_CONFIG = {
  testing: {
    loadTestVUs: 7,
    loadTestDuration: "9s",
    loadTestThresholds: {
      http_req_duration_p95: 250,
      http_req_duration_p99: 900,
      http_req_failed_rate: 0.05,
    },
  },
};

let tmp;
let counter = 0;
beforeAll(() => {
  tmp = tmpProject("nerva-loadtest-");
});
afterAll(() => tmp.cleanup());

/**
 * Build an api/ fixture and a fake bin dir. With `k6: false` the bin dir has
 * no k6 and PATH is reduced to it plus system dirs, so `k6` cannot be found
 * regardless of the host machine. `config` is exposed via NERVA_PIPELINE_CONFIG.
 */
function makeProject({ k6 = true, k6Exit = 0, config } = {}) {
  const name = `api-${counter++}`;
  const api = join(tmp.dir, name);
  mkdirSync(api, { recursive: true });
  // The generated baseline uses ESM imports; let `node --check` parse it as such.
  writeFileSync(join(api, "package.json"), '{"type":"module"}');
  const bin = join(tmp.dir, `${name}-bin`);
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "calls.log");
  if (k6) {
    writeFileSync(join(bin, "k6"), `#!/usr/bin/env bash\nprintf '%s\\n' "k6 $*" >> "${log}"\nexit ${k6Exit}\n`);
    chmodSync(join(bin, "k6"), 0o755);
  }
  const env = {
    NERVA_API_DIR: api,
    PATH: k6 ? `${bin}:${process.env.PATH}` : `${bin}:/usr/bin:/bin`,
  };
  if (config) {
    const cfg = join(tmp.dir, `${name}-config.json`);
    writeFileSync(cfg, JSON.stringify(config));
    env.NERVA_PIPELINE_CONFIG = cfg;
  }
  const baseline = join(api, "tests", "load", "baseline.js");
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { api, env, calls, baseline };
}

function expectCompleted(r) {
  expect(r.stderr).toBe("");
  expect(r.stdout).toMatch(/\[OK\] Load test completed in \d+s\./);
}

describe("load-test.sh", () => {
  it("passes bash -n", () => {
    const r = run("bash", ["-n", SCRIPT]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 1 with an install hint when k6 is not on PATH", () => {
    const { env, baseline } = makeProject({ k6: false });
    const r = runBash(SCRIPT, [], { env });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ERROR] k6 is not installed.");
    expect(r.stdout).toContain("brew install k6");
    expect(r.stdout).toContain("https://grafana.com/docs/k6/latest/set-up/install-k6/");
    expect(existsSync(baseline)).toBe(false);
  });

  describe("baseline generation", () => {
    it("creates tests/load/baseline.js from testing.* config and runs k6 with those defaults", () => {
      const { env, calls, baseline } = makeProject({ config: TUNED_CONFIG });
      const r = runBash(SCRIPT, [], { env });
      expectCompleted(r);
      expect(r.stdout).toContain("[WARN] Load test script not found. Creating default baseline...");
      expect(r.stdout).toContain(`[OK] Default baseline test created at: ${baseline}`);
      expect(r.stdout).toContain("VUs:      7");
      expect(r.stdout).toContain("Duration: 9s");
      expect(r.stdout).toContain("Command: k6 run --vus 7 --duration 9s");
      expect(calls()).toEqual([
        `k6 run --vus 7 --duration 9s -e BASE_URL=http://localhost:3000 -e VUS=7 -e DURATION=9s ${baseline}`,
      ]);
    });

    it("the generated baseline parses and carries the thresholds and BASE_URL template", () => {
      const { env, baseline } = makeProject({ config: TUNED_CONFIG });
      expectCompleted(runBash(SCRIPT, [], { env }));
      const check = run("node", ["--check", baseline]);
      expect(check.exitCode, check.stderr).toBe(0);
      const src = readFileSync(baseline, "utf8");
      expect(src).toContain("http_req_duration: ['p(95)<250', 'p(99)<900']");
      expect(src).toContain("errors: ['rate<0.05']");
      expect(src).toContain("http_req_failed: ['rate<0.05']");
      expect(src).toContain("http.get(`${BASE_URL}/health`)");
      expect(src).toContain("http.get(`${BASE_URL}/`)");
      expect(src).toContain("const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';");
      expect(src).toContain("export default function () {");
    });

    it("defaults come from the repo pipeline.config.json when no override is set", () => {
      const { env, calls, baseline } = makeProject();
      expectCompleted(runBash(SCRIPT, [], { env }));
      expect(calls()[0]).toContain("k6 run --vus 50 --duration 30s ");
      const src = readFileSync(baseline, "utf8");
      expect(src).toContain("'p(95)<500', 'p(99)<1000'");
      expect(src).toContain("rate<0.01");
    });

    it("does not overwrite an existing baseline on later runs", () => {
      const { env, baseline } = makeProject();
      mkdirSync(join(baseline, ".."), { recursive: true });
      writeFileSync(baseline, "// custom baseline\nexport default function () {}\n");
      const r = runBash(SCRIPT, [], { env });
      expectCompleted(r);
      expect(r.stdout).not.toContain("Creating default baseline");
      expect(readFileSync(baseline, "utf8")).toContain("// custom baseline");
    });
  });

  describe("flags", () => {
    it("--vus, --duration, --base-url and --script override the defaults", () => {
      const { env, calls, baseline, api } = makeProject({ config: TUNED_CONFIG });
      const custom = join(api, "tests", "load", "custom.js");
      mkdirSync(join(custom, ".."), { recursive: true });
      writeFileSync(custom, "export default function () {}\n");
      const r = runBash(
        SCRIPT,
        ["--vus", "3", "--duration", "5s", "--base-url", "http://api.test:8080", "--script", custom],
        { env },
      );
      expectCompleted(r);
      expect(r.stdout).toContain(`Script:   ${custom}`);
      expect(r.stdout).toContain("VUs:      3");
      expect(r.stdout).toContain("Duration: 5s");
      expect(r.stdout).toContain("Base URL: http://api.test:8080");
      expect(calls()).toEqual([
        `k6 run --vus 3 --duration 5s -e BASE_URL=http://api.test:8080 -e VUS=3 -e DURATION=5s ${custom}`,
      ]);
      expect(existsSync(baseline)).toBe(false);
    });

    it("--script pointing at a missing file generates the baseline at that path", () => {
      const { env, calls, api } = makeProject();
      const custom = join(api, "perf", "smoke.js");
      const r = runBash(SCRIPT, ["--script", custom], { env });
      expectCompleted(r);
      expect(r.stdout).toContain(`Default baseline test created at: ${custom}`);
      expect(existsSync(custom)).toBe(true);
      expect(calls()[0].endsWith(` ${custom}`)).toBe(true);
    });

    it("--json adds --out json=<results file> under tests/load/ and exits 0", () => {
      const { env, calls, api } = makeProject();
      const r = runBash(SCRIPT, ["--json"], { env });
      expect(r.exitCode).toBe(0);
      expectCompleted(r);
      const escaped = api.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(calls()[0]).toMatch(new RegExp(`--out json=${escaped}/tests/load/results-\\d{8}-\\d{6}\\.json`));
      expect(r.stdout).toMatch(/\[INFO\] JSON output: .*\/tests\/load\/results-\d{8}-\d{6}\.json/);
      expect(r.stdout).toMatch(/\[INFO\] Results: .*\/tests\/load\/results-\d{8}-\d{6}\.json/);
    });

    it("arguments after `--` and unknown flags reach k6 before the script path", () => {
      const { env, calls, baseline } = makeProject();
      const r = runBash(SCRIPT, ["--quiet", "--", "--http-debug", "--tag", "env=ci"], { env });
      expectCompleted(r);
      expect(calls()[0].endsWith(` --quiet --http-debug --tag env=ci ${baseline}`)).toBe(true);
    });
  });

  it("exits 1 with 'Load test failed' when k6 fails", () => {
    const { env } = makeProject({ k6Exit: 1 });
    const r = runBash(SCRIPT, [], { env });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/\[ERROR\] Load test failed after \d+s\./);
    expect(r.stdout).not.toContain("Load test completed");
  });

  // Known bug (see header comment). Marked .fails so the suite flags it once
  // fixed; flip to a regular test at that point.
  it("a successful run without --json exits 0", () => {
    const { env } = makeProject();
    const r = runBash(SCRIPT, [], { env });
    expectCompleted(r);
    expect(r.exitCode).toBe(0);
  });
});
