/**
 * Tests for scripts/validate-pipeline-config.js
 *
 * The real .claude/pipeline.config.json must validate cleanly against
 * .claude/pipeline.config.schema.json. Mutated copies exercise the schema
 * (unknown keys) and the structural checks (phase graph, deployment targets).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { run, runNode, tmpProject, REPO_ROOT, SCRIPTS_DIR } from "./helpers.js";

const SCRIPT = join(SCRIPTS_DIR, "validate-pipeline-config.js");
const CONFIG = join(REPO_ROOT, ".claude", "pipeline.config.json");
const SCHEMA = join(REPO_ROOT, ".claude", "pipeline.config.schema.json");

let tmp;
let baseConfig;

beforeAll(() => {
  tmp = tmpProject("nerva-validate-");
  baseConfig = JSON.parse(readFileSync(CONFIG, "utf8"));
});
afterAll(() => tmp.cleanup());

/** Write a mutated copy of the real config and validate it with --json. */
function validateMutated(name, mutate) {
  const config = structuredClone(baseConfig);
  mutate(config);
  const path = tmp.write(`${name}.json`, JSON.stringify(config, null, 2));
  const r = runNode(SCRIPT, ["--config", path, "--json"]);
  return { ...r, result: r.stdout ? JSON.parse(r.stdout) : null };
}

describe("validate-pipeline-config.js", () => {
  it("passes node --check", () => {
    expect(run("node", ["--check", SCRIPT]).exitCode).toBe(0);
  });

  it("the real config validates against the real schema (exit 0)", () => {
    const r = runNode(SCRIPT, []);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("VALID: pipeline config passes");
    expect(r.exitCode).toBe(0);
  });

  it("the config's $schema points at the local schema file", () => {
    expect(baseConfig.$schema).toBe("./pipeline.config.schema.json");
  });

  it("--json emits {valid, errors, warnings} for the real config", () => {
    const r = runNode(SCRIPT, ["--json"]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it("--help exits 0 and prints usage", () => {
    const r = runNode(SCRIPT, ["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("--config");
    expect(r.stdout).toContain("--json");
  });

  it("an unknown flag exits 2", () => {
    const r = runNode(SCRIPT, ["--bogus"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Unknown argument");
  });

  it("a missing config file exits 2", () => {
    const r = runNode(SCRIPT, ["--config", join(tmp.dir, "does-not-exist.json")]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not found");
  });

  it("a missing config file with --json exits 2 and reports valid:false", () => {
    const r = runNode(SCRIPT, ["--config", join(tmp.dir, "nope.json"), "--json"]);
    expect(r.exitCode).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out.valid).toBe(false);
    expect(out.errors[0].message).toContain("not found");
  });

  it("malformed JSON exits 2", () => {
    const path = tmp.write("broken.json", "{ not json");
    const r = runNode(SCRIPT, ["--config", path]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Failed to parse");
  });

  it("honors NERVA_PIPELINE_CONFIG when --config is omitted", () => {
    const path = tmp.write("env.json", JSON.stringify({ version: "1.0.0" }));
    const r = runNode(SCRIPT, ["--json"], { env: { NERVA_PIPELINE_CONFIG: path } });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).valid).toBe(true);
  });

  it("an unknown top-level key fails with a JSON-pointer path", () => {
    const { exitCode, result } = validateMutated("unknown-top", (c) => {
      c.bogusSection = { a: 1 };
    });
    expect(exitCode).toBe(1);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      path: "/",
      message: 'unexpected property "bogusSection"',
    });
  });

  it("an unknown nested key fails at every object level", () => {
    const { exitCode, result } = validateMutated("unknown-nested", (c) => {
      c.deployment.awsLambda.coldStartMagic = true;
    });
    expect(exitCode).toBe(1);
    expect(result.errors.map((e) => e.path)).toContain("/deployment/awsLambda");
    expect(result.errors[0].message).toContain("coldStartMagic");
  });

  it("an enum violation lists the allowed values", () => {
    const { exitCode, result } = validateMutated("bad-enum", (c) => {
      c.auth.defaultStrategy = "magic-link";
    });
    expect(exitCode).toBe(1);
    const err = result.errors.find((e) => e.path === "/auth/defaultStrategy");
    expect(err).toBeDefined();
    expect(err.message).toContain('"jwt"');
  });

  it("a percentage above 100 fails", () => {
    const { exitCode, result } = validateMutated("bad-pct", (c) => {
      c.qualityGate.coverageThreshold = 150;
    });
    expect(exitCode).toBe(1);
    expect(result.errors.some((e) => e.path === "/qualityGate/coverageThreshold")).toBe(true);
  });

  it("a malformed duration fails", () => {
    const { exitCode, result } = validateMutated("bad-duration", (c) => {
      c.auth.tokenExpiry = "fifteen minutes";
    });
    expect(exitCode).toBe(1);
    expect(result.errors.some((e) => e.path === "/auth/tokenExpiry")).toBe(true);
  });

  it("a non-semver version fails", () => {
    const { exitCode, result } = validateMutated("bad-version", (c) => {
      c.version = "1.0";
    });
    expect(exitCode).toBe(1);
    const versionErrors = result.errors.filter((e) => e.path === "/version");
    expect(versionErrors).toHaveLength(1);
  });

  it("a phase dependency cycle fails", () => {
    const { exitCode, result } = validateMutated("cycle", (c) => {
      c.orchestration.phases["schema-intake"].depends = ["report"];
    });
    expect(exitCode).toBe(1);
    const cycle = result.errors.find((e) => e.path === "/orchestration/phases");
    expect(cycle).toBeDefined();
    expect(cycle.message).toContain("dependency cycle");
    expect(cycle.message).toContain("schema-intake");
    expect(cycle.message).toContain("report");
  });

  it("a depends entry naming a missing phase fails", () => {
    const { exitCode, result } = validateMutated("missing-dep", (c) => {
      c.orchestration.phases["report"].depends.push("nonexistent-phase");
    });
    expect(exitCode).toBe(1);
    expect(result.errors).toContainEqual({
      path: "/orchestration/phases/report/depends",
      message: 'references unknown phase "nonexistent-phase"',
    });
    // A missing dependency must not also be reported as a cycle.
    expect(result.errors.some((e) => e.message.includes("dependency cycle"))).toBe(false);
    // report is blocking, so it is also flagged as unreachable.
    expect(result.errors.some((e) => e.path === "/orchestration/phases/report")).toBe(true);
  });

  it("a non-blocking phase with a missing dependency is not flagged as unreachable", () => {
    const { result } = validateMutated("missing-dep-nonblocking", (c) => {
      c.orchestration.phases["documentation"].depends = ["ghost"];
    });
    expect(result.errors.some((e) => e.path === "/orchestration/phases/documentation")).toBe(
      false,
    );
    expect(
      result.errors.some((e) => e.path === "/orchestration/phases/documentation/depends"),
    ).toBe(true);
  });

  it("empty qualityGateSubtasks fails when orchestration is enabled", () => {
    const { exitCode, result } = validateMutated("no-subtasks", (c) => {
      c.orchestration.qualityGateSubtasks = {};
    });
    expect(exitCode).toBe(1);
    expect(result.errors.some((e) => e.path === "/orchestration/qualityGateSubtasks")).toBe(true);
  });

  it("empty qualityGateSubtasks is allowed when orchestration is disabled", () => {
    const { exitCode } = validateMutated("no-subtasks-disabled", (c) => {
      c.orchestration.enabled = false;
      c.orchestration.qualityGateSubtasks = {};
    });
    expect(exitCode).toBe(0);
  });

  it("defaultTarget not in targets fails", () => {
    const { exitCode, result } = validateMutated("bad-target", (c) => {
      c.deployment.targets = ["node-docker", "fly"];
      c.deployment.defaultTarget = "cloudflare-workers";
    });
    expect(exitCode).toBe(1);
    const err = result.errors.find((e) => e.path === "/deployment/defaultTarget");
    expect(err).toBeDefined();
    expect(err.message).toContain("cloudflare-workers");
  });

  it("coverage threshold drift is a warning, not an error", () => {
    const { exitCode, result } = validateMutated("coverage-drift", (c) => {
      c.tdd.coverageThreshold = 70;
    });
    expect(exitCode).toBe(0);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].path).toBe("/tdd/coverageThreshold");
    expect(result.warnings[0].message).toContain("70 vs 80");
  });

  it("human output lists errors with paths", () => {
    const config = structuredClone(baseConfig);
    config.deployment.defaultTarget = "railway";
    config.deployment.targets = ["fly"];
    const path = tmp.write("human.json", JSON.stringify(config));
    const r = runNode(SCRIPT, ["--config", path]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Errors (1):");
    expect(r.stdout).toContain("/deployment/defaultTarget");
    expect(r.stdout).toContain("INVALID");
  });

  it("accepts an alternate --schema", () => {
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
    schema.required = ["version", "database"];
    const schemaPath = tmp.write("alt-schema.json", JSON.stringify(schema));
    const configPath = tmp.write("alt-config.json", JSON.stringify({ version: "1.0.0" }));
    const r = runNode(SCRIPT, ["--config", configPath, "--schema", schemaPath, "--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).errors).toContainEqual({
      path: "/",
      message: 'missing required property "database"',
    });
  });
});
