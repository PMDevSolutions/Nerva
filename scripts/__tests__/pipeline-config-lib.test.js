/**
 * Tests for scripts/lib/pipeline-config.js — the shared config reader used by
 * scripts and hooks (getValue/loadConfig as ESM, and the `get` CLI that
 * common.sh's common_config_get wraps).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { runNode, run, tmpProject, SCRIPTS_DIR, REPO_ROOT } from "./helpers.js";
import { getValue, loadConfig, renderForShell, DEFAULT_CONFIG_PATH } from "../lib/pipeline-config.js";

const LIB = join(SCRIPTS_DIR, "lib", "pipeline-config.js");
const COMMON = join(SCRIPTS_DIR, "lib", "common.sh");

let tmp;
let customConfig;

beforeAll(() => {
  tmp = tmpProject("nerva-config-lib-");
  customConfig = tmp.write(
    "custom.json",
    JSON.stringify({
      version: "9.9.9",
      tdd: { coverageThreshold: 42, enforced: false },
      nested: { list: [1, 2], obj: { a: "b" }, nul: null },
    }),
  );
});
afterAll(() => tmp.cleanup());

describe("pipeline-config.js (library)", () => {
  it("DEFAULT_CONFIG_PATH points at .claude/pipeline.config.json in the repo", () => {
    expect(DEFAULT_CONFIG_PATH).toBe(join(REPO_ROOT, ".claude", "pipeline.config.json"));
  });

  it("loadConfig reads the real config", () => {
    const cfg = loadConfig();
    expect(cfg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cfg.tdd.enforced).toBe(true);
  });

  it("getValue reads dotted paths from the real config", () => {
    expect(getValue("tdd.coverageThreshold")).toBe(80);
    expect(getValue("deployment.defaultTarget")).toBe("cloudflare-workers");
    expect(getValue("orchestration.phases.report.depends")).toEqual([
      "quality-gate",
      "documentation",
    ]);
  });

  it("getValue returns the default for a missing key", () => {
    expect(getValue("does.not.exist", "fallback")).toBe("fallback");
    expect(getValue("does.not.exist")).toBeUndefined();
    expect(getValue("tdd.coverageThreshold.deeper", 7)).toBe(7);
  });

  it("getValue honors a boolean false default", () => {
    expect(getValue("nope.nothing", false)).toBe(false);
    expect(getValue("nope.nothing", 0)).toBe(0);
    expect(getValue("nope.nothing", "")).toBe("");
  });

  it("getValue returns a stored false rather than the default", () => {
    expect(getValue("database.uuidPrimaryKeys", true)).toBe(false);
  });

  it("getValue accepts an explicit config path", () => {
    expect(getValue("tdd.coverageThreshold", 80, customConfig)).toBe(42);
    expect(getValue("tdd.enforced", true, customConfig)).toBe(false);
    expect(getValue("nested.nul", "dflt", customConfig)).toBeNull();
  });

  it("loadConfig returns {} for a missing or malformed file", () => {
    expect(loadConfig(join(tmp.dir, "missing.json"))).toEqual({});
    const broken = tmp.write("broken.json", "{ nope");
    expect(loadConfig(broken)).toEqual({});
  });

  it("renderForShell formats values for bash consumption", () => {
    expect(renderForShell(true)).toBe("true");
    expect(renderForShell(false)).toBe("false");
    expect(renderForShell(80)).toBe("80");
    expect(renderForShell("x")).toBe("x");
    expect(renderForShell(null)).toBe("");
    expect(renderForShell(undefined)).toBe("");
    expect(renderForShell([1, 2])).toBe("[1,2]");
    expect(renderForShell({ a: "b" })).toBe('{"a":"b"}');
  });
});

describe("pipeline-config.js (CLI)", () => {
  it("get prints a value from the real config", () => {
    const r = runNode(LIB, ["get", "tdd.coverageThreshold"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("80");
  });

  it("get prints the default for a missing key", () => {
    const r = runNode(LIB, ["get", "no.such.key", "dflt"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("dflt");
  });

  it("get prints an empty string for a missing key with no default", () => {
    const r = runNode(LIB, ["get", "no.such.key"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("get round-trips a false default", () => {
    const r = runNode(LIB, ["get", "no.such.key", "false"]);
    expect(r.stdout).toBe("false");
  });

  it("get renders booleans and objects for shell", () => {
    expect(runNode(LIB, ["get", "tdd.enforced"]).stdout).toBe("true");
    expect(runNode(LIB, ["get", "database.uuidPrimaryKeys", "true"]).stdout).toBe("false");
    expect(JSON.parse(runNode(LIB, ["get", "deployment.targets"]).stdout)).toContain("fly");
  });

  it("NERVA_PIPELINE_CONFIG overrides the config path", () => {
    const env = { NERVA_PIPELINE_CONFIG: customConfig };
    expect(runNode(LIB, ["get", "tdd.coverageThreshold", "80"], { env }).stdout).toBe("42");
    expect(runNode(LIB, ["get", "version"], { env }).stdout).toBe("9.9.9");
    expect(runNode(LIB, ["get", "tdd.enforced", "true"], { env }).stdout).toBe("false");
  });

  it("NERVA_PIPELINE_CONFIG pointing at a missing file yields the default, exit 0", () => {
    const env = { NERVA_PIPELINE_CONFIG: join(tmp.dir, "absent.json") };
    const r = runNode(LIB, ["get", "tdd.coverageThreshold", "55"], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("55");
  });

  it("bad usage still exits 0 and prints the default", () => {
    const r = runNode(LIB, ["frobnicate", "x", "d"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("d");
    // helpers.run() drops stderr on a zero exit, so the usage line printed to
    // stderr is not observable here; the contract under test is exit 0 + default.
  });

  it("common_config_get in common.sh wraps the CLI", () => {
    const script = `source "${COMMON}"; common_config_get tdd.coverageThreshold 0; echo; common_config_get missing.key dflt`;
    const r = run("bash", ["-c", script]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("80\ndflt");
    const env = { NERVA_PIPELINE_CONFIG: customConfig };
    expect(run("bash", ["-c", `source "${COMMON}"; common_config_get tdd.coverageThreshold 0`], { env }).stdout).toBe("42");
  });
});
