import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { readdirSync, existsSync, statSync } from "fs";
import { runBash, tmpProject, SCRIPTS_DIR, REPO_ROOT } from "./helpers.js";

const SCRIPT = join(SCRIPTS_DIR, "check-doc-counts.sh");

/**
 * Tests for scripts/check-doc-counts.sh
 *
 * Two strategies:
 *   1. A throwaway fixture tree (via --root) exercises the in-sync and drift
 *      paths deterministically, including the exclusion rules.
 *   2. A run against the real repo asserts that the counts the tool reports
 *      match what is on disk and that every reported violation is internally
 *      consistent. The real repo is allowed to have drift (other work may add
 *      scripts faster than the docs are updated), so this never asserts that
 *      drift is zero — only that it is reported correctly.
 */

function run(args = [], opts = {}) {
  return runBash(SCRIPT, args, opts);
}

// --- Disk counts, computed independently of the script -------------------

function countAgents(root) {
  const dir = join(root, ".claude", "agents");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md" && statSync(join(dir, f)).isFile(),
  ).length;
}

function countSkills(root) {
  const dir = join(root, ".claude", "skills");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() && existsSync(join(full, "SKILL.md"));
  }).length;
}

function countScripts(root) {
  const dir = join(root, "scripts");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(
    (f) => (f.endsWith(".sh") || f.endsWith(".js")) && statSync(join(dir, f)).isFile(),
  ).length;
}

function countCommands(root) {
  const dir = join(root, ".claude", "commands");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith(".md") && statSync(join(dir, f)).isFile())
    .length;
}

function diskCounts(root) {
  return {
    agents: countAgents(root),
    skills: countSkills(root),
    scripts: countScripts(root),
    commands: countCommands(root),
  };
}

// --- Fixture --------------------------------------------------------------

/** 2 agents, 2 skills, 2 scripts, 1 command. */
function buildFixture(project) {
  project.write(".claude/agents/alpha.md", "# alpha\n");
  project.write(".claude/agents/beta.md", "# beta\n");
  project.write(".claude/agents/README.md", "# not an agent\n");
  project.write(".claude/skills/x/SKILL.md", "# x\n");
  project.write(".claude/skills/y/SKILL.md", "# y\n");
  project.write(".claude/skills/z/notes.md", "# z has no SKILL.md\n");
  project.write("scripts/one.sh", "#!/usr/bin/env bash\n");
  project.write("scripts/two.js", "// js\n");
  project.write("scripts/lib/common.sh", "# excluded: lib\n");
  project.write("scripts/__tests__/two.test.js", "// excluded: tests\n");
  project.write(".claude/commands/go.md", "# go\n");

  // Files that must be ignored even though they contain wrong counts.
  project.write("CHANGELOG.md", "## 1.0.0\n- shipped 99 agents and 99 skills\n");
  project.write("RELEASE_NOTES.md", "99 scripts\n");
  project.write("docs/plans/2026-01-01-plan.md", "Plan for 99 skills\n");
  project.write("examples/demo/README.md", "This example has 99 scripts and 99 agents\n");
  project.write("node_modules/pkg/README.md", "99 agents\n");
}

const IN_SYNC_README = [
  "# Fixture",
  "",
  "Ships with 2 specialized agents and 2 skills.",
  "",
  "### Custom Agents (2 Total)",
  "",
  "**Total Skills:** 2",
  "",
  "| Category | Count |",
  "|----------|-------|",
  "| Engineering | 6 |",
  "",
  "Automation scripts (2 total). Load tests use k6 scripts in tests/load/.",
  "",
  "**Total Commands:** 1",
  "",
].join("\n");

describe("check-doc-counts.sh — help flag", () => {
  it("shows usage and exits 0", () => {
    const r = run(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("--json");
    expect(r.stdout).toContain("--root");
  });
});

describe("check-doc-counts.sh — usage errors", () => {
  it("exits 2 on an unknown argument", () => {
    const r = run(["--bogus"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Unknown argument");
  });

  it("exits 2 when --root is not a directory", () => {
    const r = run(["--root", "/definitely/not/here"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Not a directory");
  });

  it("exits 2 when --root has no argument", () => {
    const r = run(["--root"]);
    expect(r.exitCode).toBe(2);
  });
});

describe("check-doc-counts.sh — fixture: in sync", () => {
  let project;
  beforeAll(() => {
    project = tmpProject("nerva-doc-counts-sync-");
    buildFixture(project);
    project.write("README.md", IN_SYNC_README);
  });
  afterAll(() => project.cleanup());

  it("counts entries on disk using the documented rules", () => {
    const r = run(["--root", project.dir, "--json"]);
    const json = JSON.parse(r.stdout);
    expect(json.agents).toBe(2); // README.md excluded
    expect(json.skills).toBe(2); // z/ has no SKILL.md
    expect(json.scripts).toBe(2); // lib/ and __tests__/ excluded
    expect(json.commands).toBe(1);
    expect(diskCounts(project.dir)).toEqual({ agents: 2, skills: 2, scripts: 2, commands: 1 });
  });

  it("exits 0 and reports all counts in sync", () => {
    const r = run(["--root", project.dir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Documentation Count Check");
    expect(r.stdout).toContain("On disk: 2 agents, 2 skills, 2 scripts, 1 commands");
    expect(r.stdout).toContain("match the entries on disk");
  });

  it("ignores table cells, k6 scripts, and excluded files", () => {
    const r = run(["--root", project.dir, "--json"]);
    const json = JSON.parse(r.stdout);
    expect(json.drift).toBe(0);
    expect(json.violations).toEqual([]);
    // Scanned: README.md, 3 agent .md files, 3 skill .md files, 1 command .md.
    // CHANGELOG.md, RELEASE_NOTES.md, docs/plans/, examples/, node_modules/ are not.
    expect(json.docsScanned).toBe(8);
  });
});

describe("check-doc-counts.sh — fixture: drift", () => {
  let project;
  beforeAll(() => {
    project = tmpProject("nerva-doc-counts-drift-");
    buildFixture(project);
    project.write(
      "README.md",
      [
        "# Fixture",
        "",
        "Ships with 5 custom agents and 2 skills.",
        "",
        "### Skills (7 Total)",
        "",
        "**Total Scripts:** 2",
        "",
      ].join("\n"),
    );
    project.write("docs/guide.md", "There are 4 commands available.\n");
  });
  afterAll(() => project.cleanup());

  it("exits 1 and lists file:line with claimed vs actual", () => {
    const r = run(["--root", project.dir]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("3 documentation count claim(s) drifted");
    expect(r.stdout).toContain("README.md:3: claims 5 agents, actual 2");
    expect(r.stdout).toContain("README.md:5: claims 7 skills, actual 2");
    expect(r.stdout).toContain("docs/guide.md:1: claims 4 commands, actual 1");
    // The correct claims on the same lines are not reported.
    expect(r.stdout).not.toContain("claims 2 skills");
    expect(r.stdout).not.toContain("claims 2 scripts");
  });

  it("--json describes each violation as a structured object", () => {
    const r = run(["--root", project.dir, "--json"]);
    expect(r.exitCode).toBe(1);
    const json = JSON.parse(r.stdout);
    expect(json).toMatchObject({ agents: 2, skills: 2, scripts: 2, commands: 1, drift: 3 });
    expect(json.violations).toHaveLength(3);
    for (const v of json.violations) {
      expect(typeof v.file).toBe("string");
      expect(typeof v.line).toBe("number");
      expect(typeof v.claimed).toBe("number");
      expect(typeof v.actual).toBe("number");
      expect(typeof v.text).toBe("string");
      expect(["agents", "skills", "scripts", "commands"]).toContain(v.noun);
      expect(v.claimed).not.toBe(v.actual);
    }
    expect(json.violations).toContainEqual({
      file: "README.md",
      line: 3,
      noun: "agents",
      claimed: 5,
      actual: 2,
      text: "5 custom agents",
    });
    expect(json.violations).toContainEqual({
      file: "docs/guide.md",
      line: 1,
      noun: "commands",
      claimed: 4,
      actual: 1,
      text: "4 commands",
    });
  });
});

describe("check-doc-counts.sh — real repository", () => {
  it("reports on-disk counts that match an independent count", () => {
    const r = run(["--json"], { cwd: REPO_ROOT });
    const json = JSON.parse(r.stdout);
    const disk = diskCounts(REPO_ROOT);
    expect(json.agents).toBe(disk.agents);
    expect(json.skills).toBe(disk.skills);
    expect(json.scripts).toBe(disk.scripts);
    expect(json.commands).toBe(disk.commands);
    expect(json.docsScanned).toBeGreaterThan(0);
  });

  it("reports drift consistently: violations, exit code, and actual counts agree", () => {
    const r = run(["--json"], { cwd: REPO_ROOT });
    const json = JSON.parse(r.stdout);
    const disk = diskCounts(REPO_ROOT);
    expect(Array.isArray(json.violations)).toBe(true);
    expect(json.violations).toHaveLength(json.drift);
    expect(r.exitCode).toBe(json.drift === 0 ? 0 : 1);
    for (const v of json.violations) {
      expect(v.actual).toBe(disk[v.noun]);
      expect(v.claimed).not.toBe(v.actual);
      expect(existsSync(join(REPO_ROOT, v.file))).toBe(true);
      expect(v.line).toBeGreaterThan(0);
    }
  });

  it("human-readable output names each drifted claim as file:line", () => {
    const json = JSON.parse(run(["--json"], { cwd: REPO_ROOT }).stdout);
    const r = run([], { cwd: REPO_ROOT });
    const disk = diskCounts(REPO_ROOT);
    expect(r.stdout).toContain(
      `On disk: ${disk.agents} agents, ${disk.skills} skills, ${disk.scripts} scripts, ${disk.commands} commands`,
    );
    for (const v of json.violations) {
      expect(r.stdout).toContain(
        `${v.file}:${v.line}: claims ${v.claimed} ${v.noun}, actual ${v.actual}`,
      );
    }
  });

  it("never treats 'k6 scripts' as a count claim", () => {
    const json = JSON.parse(run(["--json"], { cwd: REPO_ROOT }).stdout);
    for (const v of json.violations) {
      expect(v.text).not.toMatch(/k6/i);
    }
  });
});
