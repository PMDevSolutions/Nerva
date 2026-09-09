/**
 * Tests for scripts/check-prerequisites.sh
 *
 * The script's output is a stable, machine-parseable contract (section
 * headers, [PASS]/[FAIL]/[SKIP]/[INFO] lines, the summary block, exit codes).
 * Tool detection depends on the machine, so assertions on this machine only
 * pin the contract; NERVA_PROJECT_ROOT and NERVA_PLUGINS_FILE drive the
 * deterministic PROJECT and CLAUDE CODE cases.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { run, runBash, tmpProject, SCRIPTS_DIR } from "./helpers.js";

const SCRIPT = join(SCRIPTS_DIR, "check-prerequisites.sh");
const SECTIONS = ["REQUIRED SOFTWARE", "OPTIONAL SOFTWARE", "CLAUDE CODE", "PROJECT"];

let tmp;
beforeAll(() => {
  tmp = tmpProject("nerva-prereq-");
});
afterAll(() => tmp.cleanup());

describe("check-prerequisites.sh", () => {
  it("passes bash -n", () => {
    expect(run("bash", ["-n", SCRIPT]).exitCode).toBe(0);
  });

  it("emits every section header with a dashed underline, in order", () => {
    const { stdout } = runBash(SCRIPT);
    let last = -1;
    for (const h of SECTIONS) {
      const idx = stdout.indexOf(`\n${h}\n${"-".repeat(h.length)}\n`);
      expect(idx, `section ${h}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("every result line uses a known status tag and hints are indented", () => {
    const { stdout } = runBash(SCRIPT);
    const body = stdout.split("=== Summary ===")[0];
    const lines = body.split("\n").filter((l) => l.trim() !== "");
    const resultLines = lines.filter((l) => l.startsWith("["));
    expect(resultLines.length).toBeGreaterThan(10);
    for (const l of resultLines) {
      expect(l).toMatch(/^\[(PASS|FAIL|SKIP|INFO)\] \S/);
    }
    const hintLines = lines.filter((l) => l.startsWith(" "));
    for (const l of hintLines) expect(l).toMatch(/^ {7}\S/);
  });

  it("prints the summary block and a YES|NO verdict with a matching exit code", () => {
    const { stdout, exitCode } = runBash(SCRIPT);
    expect(stdout).toContain("=== Summary ===");
    expect(stdout).toMatch(/^Required: \d+\/4 passed$/m);
    expect(stdout).toMatch(/^Optional: \d+\/10 installed$/m);
    expect(stdout).toMatch(/^Claude Code: \d+\/4 ready$/m);
    expect(stdout).toMatch(/^Project: \d+\/5 ready$/m);
    const verdict = stdout.match(/^Ready to use Nerva: (YES|NO)$/m);
    expect(verdict).not.toBeNull();
    expect([0, 1]).toContain(exitCode);
    expect(exitCode).toBe(verdict[1] === "YES" ? 0 : 1);
  });

  it("reports required tool minimums and the Node 22 recommendation", () => {
    const { stdout } = runBash(SCRIPT);
    expect(stdout).toMatch(/\[(PASS|FAIL)\] Git .*minimum: 2\.30\.0/);
    expect(stdout).toMatch(/\[(PASS|FAIL)\] Node\.js .*minimum: 20\.0\.0, recommended: 22/);
    expect(stdout).toMatch(/\[(PASS|FAIL)\] pnpm .*minimum: 9\.0\.0/);
    expect(stdout).toMatch(/\[PASS\] Bash \d/);
  });

  it("the framework checkout reports a ready PROJECT section with api/ as INFO", () => {
    const { stdout } = runBash(SCRIPT);
    expect(stdout).toContain("[PASS] node_modules present");
    expect(stdout).toContain("[PASS] .claude/pipeline.config.json parses");
    expect(stdout).toContain("[PASS] .husky/pre-commit hook present");
    expect(stdout).toMatch(/\[PASS\] \.claude\/agents contains \d+ agent\(s\)/);
    expect(stdout).toMatch(/\[PASS\] \.claude\/skills contains \d+ skill\(s\)/);
    expect(stdout).toContain("[INFO] api/ not present");
    expect(stdout).toContain("Project: 5/5 ready");
  });

  it("NERVA_PROJECT_ROOT pointing at an empty dir makes the PROJECT section fail", () => {
    const empty = join(tmp.dir, "empty");
    mkdirSync(empty, { recursive: true });
    const { stdout, exitCode } = runBash(SCRIPT, [], { env: { NERVA_PROJECT_ROOT: empty } });
    expect(stdout).toContain("[FAIL] node_modules missing at repo root");
    expect(stdout).toContain("       Run: pnpm install");
    expect(stdout).toContain("[FAIL] .claude/pipeline.config.json not found");
    expect(stdout).toContain("[FAIL] .husky/pre-commit hook missing");
    expect(stdout).toContain("[FAIL] .claude/agents is missing or empty");
    expect(stdout).toContain("[FAIL] .claude/skills is missing or empty");
    expect(stdout).toContain("Project: 0/5 ready");
    expect(stdout).toContain("Ready to use Nerva: NO");
    expect(exitCode).toBe(1);
  });

  it("a malformed pipeline.config.json is a PROJECT failure", () => {
    const root = join(tmp.dir, "broken-config");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "pipeline.config.json"), "{ nope");
    const { stdout, exitCode } = runBash(SCRIPT, [], { env: { NERVA_PROJECT_ROOT: root } });
    expect(stdout).toContain("[FAIL] .claude/pipeline.config.json is not valid JSON");
    expect(exitCode).toBe(1);
  });

  it("a non-existent NERVA_PROJECT_ROOT is a script error (exit 2)", () => {
    const r = runBash(SCRIPT, [], { env: { NERVA_PROJECT_ROOT: join(tmp.dir, "nowhere") } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Project root does not exist");
  });

  it("NERVA_PLUGINS_FILE pointing at a plugin registry lists installed plugins", () => {
    const pluginsFile = tmp.write(
      "installed_plugins.json",
      JSON.stringify({
        version: 2,
        plugins: {
          "superpowers@claude-plugins-official": [{ version: "6.3.0" }],
          "episodic-memory@claude-plugins-official": [{ version: "1.2.0" }],
        },
      }),
    );
    const { stdout } = runBash(SCRIPT, [], { env: { NERVA_PLUGINS_FILE: pluginsFile } });
    expect(stdout).toContain("[PASS] superpowers plugin 6.3.0");
    expect(stdout).toContain("[PASS] episodic-memory plugin 1.2.0");
    expect(stdout).toContain("[SKIP] commit-commands plugin not installed");
    expect(stdout).toContain("       Install in Claude Code: /plugin install commit-commands");
    expect(stdout).toContain("[INFO] ai-taskmaster is a local plugin");
    expect(stdout).toMatch(/^Claude Code: [23]\/4 ready$/m);
  });

  it("a missing plugin registry SKIPs every plugin instead of failing", () => {
    const missing = join(tmp.dir, "no-such-plugins.json");
    const { stdout } = runBash(SCRIPT, [], { env: { NERVA_PLUGINS_FILE: missing } });
    for (const p of ["episodic-memory", "commit-commands", "superpowers"]) {
      expect(stdout).toContain(`[SKIP] ${p} plugin: cannot verify`);
    }
    expect(stdout).toContain(`       Plugin registry not found at ${missing}`);
  });

  it("--json emits the same data as JSON", () => {
    const text = runBash(SCRIPT);
    const r = runBash(SCRIPT, ["--json"]);
    expect(r.exitCode).toBe(text.exitCode);
    const out = JSON.parse(r.stdout);
    expect(out.ready).toBe(text.exitCode === 0);
    expect(out.exitCode).toBe(text.exitCode);
    expect(out.summary.required.total).toBe(4);
    expect(out.summary.optional.total).toBe(10);
    expect(out.summary.claudeCode.total).toBe(4);
    expect(out.summary.project.total).toBe(5);
    expect(Array.isArray(out.checks)).toBe(true);
    // Same results as the text report, in the same order.
    const textResults = text.stdout
      .split("=== Summary ===")[0]
      .split("\n")
      .filter((l) => /^\[(PASS|FAIL|SKIP|INFO)\] /.test(l))
      .map((l) => ({ status: l.slice(1, 5), detail: l.slice(7) }));
    expect(out.checks.map((c) => ({ status: c.status, detail: c.detail }))).toEqual(textResults);
    for (const c of out.checks) {
      expect(SECTIONS).toContain(c.section);
      expect(["PASS", "FAIL", "SKIP", "INFO"]).toContain(c.status);
      expect(Array.isArray(c.hints)).toBe(true);
    }
    const nm = out.checks.find((c) => c.detail === "node_modules present");
    expect(nm.section).toBe("PROJECT");
    // Summary numbers agree with the per-check statuses.
    const passed = out.checks.filter((c) => c.section === "PROJECT" && c.status === "PASS");
    expect(passed).toHaveLength(out.summary.project.ready);
  });

  it("--json carries hints for failing checks", () => {
    const empty = join(tmp.dir, "empty-json");
    mkdirSync(empty, { recursive: true });
    const r = runBash(SCRIPT, ["--json"], { env: { NERVA_PROJECT_ROOT: empty } });
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.ready).toBe(false);
    const nm = out.checks.find((c) => c.detail === "node_modules missing at repo root");
    expect(nm.status).toBe("FAIL");
    expect(nm.hints).toEqual(["Run: pnpm install"]);
  });

  it("--help exits 0 with the output contract", () => {
    const r = runBash(SCRIPT, ["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Output contract");
    expect(r.stdout).toContain("NERVA_PROJECT_ROOT");
  });

  it("an unknown flag exits 2", () => {
    const r = runBash(SCRIPT, ["--wat"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Unknown argument");
  });

  it("disables colors under NO_COLOR", () => {
    const { stdout } = runBash(SCRIPT);
    // eslint-disable-next-line no-control-regex
    expect(stdout).not.toMatch(/\x1b\[/);
  });
});
