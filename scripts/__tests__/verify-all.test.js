import { describe, it, expect, afterAll } from "vitest";
import { join } from "path";
import { runBash, tmpProject, SCRIPTS_DIR, REPO_ROOT } from "./helpers.js";

const SCRIPT = join(SCRIPTS_DIR, "verify-all.sh");

/**
 * Tests for scripts/verify-all.sh
 *
 * Fast, deterministic checks (shell-syntax, json) are exercised against the
 * real repo via --include. Everything that depends on which backing scripts
 * exist, or on a check failing, uses a throwaway fixture tree via --root with
 * stub scripts that exit with a known code. Fixtures never contain a
 * package.json, so the (slow, recursive) script-tests check always skips.
 */

const ALL_CHECKS = [
  "shell-syntax",
  "js-syntax",
  "json",
  "pipeline-config",
  "doc-counts",
  "script-tests",
  "types",
  "tests",
  "security",
  "destructive-migrations",
];

const projects = [];
afterAll(() => {
  for (const p of projects) p.cleanup();
});

function fixture() {
  const p = tmpProject("nerva-verify-all-");
  projects.push(p);
  return p;
}

function run(args = [], opts = {}) {
  return runBash(SCRIPT, args, { cwd: REPO_ROOT, ...opts });
}

function parse(r) {
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch (err) {
    throw new Error(`stdout is not JSON (${err.message}):\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  }
  return json;
}

function byName(json, name) {
  return json.checks.find((c) => c.name === name);
}

describe("--list", () => {
  it("prints every check name in run order and exits 0", () => {
    const r = run(["--list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(ALL_CHECKS);
  });
});

describe("--help", () => {
  it("prints usage and exits 0", () => {
    const r = run(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
    for (const flag of ["--json", "--ci", "--skip", "--include", "--list", "--root"]) {
      expect(r.stdout).toContain(flag);
    }
  });
});

describe("usage errors", () => {
  it("exits 2 on an unknown flag", () => {
    const r = run(["--nope"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Unknown argument");
  });

  it("exits 2 when --include names an unknown check", () => {
    const r = run(["--include", "shell-syntax,not-a-check"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Unknown check name for --include: not-a-check");
    expect(r.stderr).toContain("Valid names:");
  });

  it("exits 2 when --skip names an unknown check", () => {
    const r = run(["--skip", "nope"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Unknown check name for --skip: nope");
  });

  it("exits 2 when --root is not a directory", () => {
    const r = run(["--root", "/definitely/not/here", "--json"]);
    expect(r.exitCode).toBe(2);
  });
});

describe("--json against the real repo", () => {
  it("--include shell-syntax,json runs only those and reports the documented shape", () => {
    const r = run(["--json", "--include", "shell-syntax,json"]);
    expect(r.exitCode).toBe(0);
    const json = parse(r);

    expect(json.status).toBe("pass");
    expect(json.checks.map((c) => c.name)).toEqual(ALL_CHECKS);
    expect(json.summary).toMatchObject({ passed: 2, failed: 0, skipped: 8 });

    for (const check of json.checks) {
      expect(typeof check.name).toBe("string");
      expect(["pass", "fail", "skip"]).toContain(check.status);
      expect(typeof check.exitCode).toBe("number");
      expect(typeof check.durationMs).toBe("number");
      if (check.status === "pass") {
        expect(check).not.toHaveProperty("reason");
      } else {
        expect(typeof check.reason).toBe("string");
      }
    }

    expect(byName(json, "shell-syntax")).toMatchObject({ status: "pass", exitCode: 0 });
    expect(byName(json, "json")).toMatchObject({ status: "pass", exitCode: 0 });
    expect(byName(json, "script-tests").reason).toContain("filtered by --skip/--include");
    expect(byName(json, "types").reason).toContain("filtered by --skip/--include");
  });

  it("--ci implies --json", () => {
    const r = run(["--ci", "--include", "json"]);
    expect(r.exitCode).toBe(0);
    const json = parse(r);
    expect(json.status).toBe("pass");
    expect(byName(json, "json").status).toBe("pass");
  });

  it("human mode prints progress and a summary table", () => {
    const r = run(["--include", "shell-syntax"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("=== verify-all ===");
    expect(r.stdout).toContain("shell-syntax");
    expect(r.stdout).toContain("=== Summary ===");
    expect(r.stdout).toContain("Totals: 1 passed, 0 failed, 9 skipped");
    expect(r.stdout).toContain("All checks passed.");
  });
});

describe("--skip", () => {
  it("marks skipped checks with the filter reason and still runs the rest", () => {
    const p = fixture();
    p.write("scripts/check-doc-counts.sh", "#!/usr/bin/env bash\necho ok\nexit 0\n");
    p.write("scripts/validate-pipeline-config.js", "console.log('ok');\n");

    const withSkip = parse(
      run(["--json", "--root", p.dir, "--skip", "doc-counts,shell-syntax"]),
    );
    expect(byName(withSkip, "doc-counts")).toMatchObject({
      status: "skip",
      reason: "filtered by --skip/--include",
    });
    expect(byName(withSkip, "shell-syntax").status).toBe("skip");
    expect(byName(withSkip, "pipeline-config").status).toBe("pass");

    const without = parse(run(["--json", "--root", p.dir]));
    expect(byName(without, "doc-counts").status).toBe("pass");
    expect(byName(without, "shell-syntax").status).toBe("pass");
  });
});

describe("conditional skips", () => {
  it("skips a check whose backing script does not exist, with a reason", () => {
    const p = fixture();
    p.write("scripts/.keep", "");
    const r = run(["--json", "--root", p.dir, "--include", "pipeline-config,doc-counts"]);
    expect(r.exitCode).toBe(0);
    const json = parse(r);
    expect(json.status).toBe("pass");
    expect(byName(json, "pipeline-config")).toMatchObject({
      status: "skip",
      exitCode: 0,
      reason: "script not found: scripts/validate-pipeline-config.js",
    });
    expect(byName(json, "doc-counts")).toMatchObject({
      status: "skip",
      reason: "script not found: scripts/check-doc-counts.sh",
    });
    expect(json.summary.skipped).toBe(10);
  });

  it("skips api-dependent checks when there is no api/ directory", () => {
    const p = fixture();
    for (const s of ["check-types.sh", "run-tests.sh", "security-scan.sh"]) {
      p.write(`scripts/${s}`, "#!/usr/bin/env bash\nexit 0\n");
    }
    p.write("scripts/check-destructive-migrations.js", "process.exit(0);\n");
    const json = parse(run(["--json", "--root", p.dir]));
    for (const name of ["types", "tests", "security"]) {
      expect(byName(json, name)).toMatchObject({ status: "skip", reason: "no api/ directory" });
    }
    expect(byName(json, "destructive-migrations").status).toBe("skip");
    expect(byName(json, "destructive-migrations").reason).toContain("no migrations directory");
    expect(byName(json, "script-tests")).toMatchObject({ status: "skip", reason: "no package.json" });
    expect(json.status).toBe("pass");
  });

  it("runs api-dependent checks when api/ and migrations exist", () => {
    const p = fixture();
    for (const s of ["check-types.sh", "run-tests.sh", "security-scan.sh"]) {
      p.write(`scripts/${s}`, "#!/usr/bin/env bash\nexit 0\n");
    }
    p.write("scripts/check-destructive-migrations.js", "process.exit(0);\n");
    p.write("api/src/db/migrations/0000_init.sql", "CREATE TABLE t (id int);\n");
    const json = parse(run(["--json", "--root", p.dir]));
    for (const name of ["types", "tests", "security", "destructive-migrations"]) {
      expect(byName(json, name)).toMatchObject({ status: "pass", exitCode: 0 });
    }
  });

  it("honours NERVA_API_DIR for the api/ location", () => {
    const p = fixture();
    p.write("scripts/check-types.sh", "#!/usr/bin/env bash\nexit 0\n");
    p.write("elsewhere/package.json", "{}");
    const json = parse(
      run(["--json", "--root", p.dir, "--include", "types"], {
        env: { NERVA_API_DIR: join(p.dir, "elsewhere") },
      }),
    );
    expect(byName(json, "types").status).toBe("pass");
  });
});

describe("failing checks", () => {
  function failingFixture() {
    const p = fixture();
    p.write(
      "scripts/validate-pipeline-config.js",
      [
        "for (let i = 1; i <= 20; i++) console.log('line ' + i);",
        "console.error('\\u001b[31mboom\\u001b[0m');",
        "process.exit(3);",
      ].join("\n"),
    );
    p.write("scripts/check-doc-counts.sh", "#!/usr/bin/env bash\necho fine\n");
    return p;
  }

  it("exits 1, reports the exit code, and captures the last 15 lines of output", () => {
    const p = failingFixture();
    const r = run(["--json", "--root", p.dir, "--include", "pipeline-config,doc-counts"]);
    expect(r.exitCode).toBe(1);
    const json = parse(r);
    expect(json.status).toBe("fail");
    expect(json.summary).toMatchObject({ passed: 1, failed: 1, skipped: 8 });

    const failing = byName(json, "pipeline-config");
    expect(failing).toMatchObject({
      status: "fail",
      exitCode: 3,
      reason: "exit 3",
      command: "node scripts/validate-pipeline-config.js",
    });
    const lines = failing.output.split("\n");
    expect(lines).toHaveLength(15);
    expect(lines[0]).toBe("line 7");
    expect(lines[13]).toBe("line 20");
    expect(lines[14]).toBe("boom"); // ANSI escapes stripped
    expect(failing.durationMs).toBeGreaterThanOrEqual(0);

    expect(byName(json, "doc-counts")).toMatchObject({ status: "pass" });
  });

  it("human mode shows the output tail and the command to reproduce", () => {
    const p = failingFixture();
    const r = run(["--root", p.dir, "--include", "pipeline-config"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("fail (exit 3");
    expect(r.stdout).toContain("last 15 lines of output");
    expect(r.stdout).toContain("| line 20");
    expect(r.stdout).toContain("| boom");
    expect(r.stdout).not.toContain("| line 6");
    expect(r.stdout).toContain("Some checks failed");
    expect(r.stdout).toContain("node scripts/validate-pipeline-config.js");
    expect(r.stdout).toContain("Totals: 0 passed, 1 failed, 9 skipped");
  });

  it("a failure inside --include still exits 1 even when everything else is skipped", () => {
    const p = fixture();
    p.write("scripts/check-doc-counts.sh", "#!/usr/bin/env bash\nexit 1\n");
    const r = run(["--ci", "--root", p.dir, "--include", "doc-counts"]);
    expect(r.exitCode).toBe(1);
    expect(parse(r).status).toBe("fail");
  });

  it("inline checks fail on a syntax error and name the offending file", () => {
    const p = fixture();
    p.write("scripts/broken.sh", "#!/usr/bin/env bash\nif [ x ; then\n");
    p.write("scripts/broken.js", "function (\n");
    const r = run(["--json", "--root", p.dir, "--include", "shell-syntax,js-syntax"]);
    expect(r.exitCode).toBe(1);
    const json = parse(r);
    expect(byName(json, "shell-syntax").status).toBe("fail");
    expect(byName(json, "shell-syntax").output).toContain("scripts/broken.sh");
    expect(byName(json, "js-syntax").status).toBe("fail");
    expect(byName(json, "js-syntax").output).toContain("scripts/broken.js");
  });

  it("the json check fails on malformed JSON", () => {
    const p = fixture();
    p.write(".claude/pipeline.config.json", "{ not json");
    const r = run(["--json", "--root", p.dir, "--include", "json"]);
    expect(r.exitCode).toBe(1);
    const json = parse(r);
    expect(byName(json, "json").status).toBe("fail");
    expect(byName(json, "json").output).toContain(".claude/pipeline.config.json");
  });
});

describe("recursion guard", () => {
  it("skips script-tests when invoked from inside a verify-all run", () => {
    const p = fixture();
    p.write("package.json", JSON.stringify({ scripts: { test: "exit 1" } }));
    const json = parse(
      run(["--json", "--root", p.dir, "--include", "script-tests"], {
        env: { NERVA_VERIFY_ALL_ACTIVE: "1" },
      }),
    );
    expect(byName(json, "script-tests")).toMatchObject({ status: "skip" });
    expect(byName(json, "script-tests").reason).toContain("nested");
  });
});
