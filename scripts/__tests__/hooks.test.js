/**
 * Tests for the Claude Code hooks in .claude/hooks/.
 *
 * Every hook reads one JSON object on stdin (the Claude Code hook contract):
 *   { tool_name, tool_input: { command }, tool_response? }
 *
 * PreToolUse hooks exit 2 to block (message on stderr) and 0 to allow.
 * PostToolUse hooks always exit 0; a reminder on stdout, or nothing.
 * All hooks must exit 0 (and stay quiet) on empty or malformed stdin.
 */
import { describe, it, expect, afterAll } from "vitest";
import { join } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { run, tmpProject, HOOKS_DIR, REPO_ROOT } from "./helpers.js";

const PRE_HOOKS = ["secret-guard.sh", "prod-db-guard.sh"];
const POST_HOOKS = ["coverage-check.sh", "migration-safety-reminder.sh", "quality-gate-reminder.sh"];
const ALL_HOOKS = [...PRE_HOOKS, ...POST_HOOKS];

const projects = [];
afterAll(() => {
  for (const p of projects) p.cleanup();
});

function scratch(prefix = "nerva-hooks-") {
  const p = tmpProject(prefix);
  projects.push(p);
  return p;
}

function runHook(name, payload, opts = {}) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const { env = {}, ...rest } = opts;
  return run("bash", [join(HOOKS_DIR, name)], {
    input,
    // Neutralise any user-level bypass so assertions are deterministic.
    env: { NERVA_SKIP_HOOKS: "", ...env },
    ...rest,
  });
}

const pre = (command) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
  cwd: REPO_ROOT,
});

const post = (command, stdout = "", stderr = "") => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { stdout, stderr, interrupted: false },
  cwd: REPO_ROOT,
});

/** A pipeline.config.json in a scratch dir, returned as env for NERVA_PIPELINE_CONFIG. */
function configEnv(config) {
  const p = scratch("nerva-hooks-cfg-");
  const file = p.write(".claude/pipeline.config.json", JSON.stringify(config));
  return { NERVA_PIPELINE_CONFIG: file };
}

/** A throwaway git repo with the given files staged (tracked). */
function gitRepo(files = {}) {
  const p = scratch("nerva-hooks-git-");
  const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  expect(run("git", ["init", "-q"], { cwd: p.dir, env }).exitCode).toBe(0);
  const names = Object.keys(files);
  for (const name of names) p.write(name, files[name]);
  if (names.length > 0) {
    // -f so a global excludes file that ignores .env cannot break the fixture.
    expect(run("git", ["add", "-f", "--", ...names], { cwd: p.dir, env }).exitCode).toBe(0);
  }
  return p;
}

// ---------------------------------------------------------------------------

describe("hook files", () => {
  const libs = readdirSync(join(HOOKS_DIR, "lib")).filter((f) => f.endsWith(".sh"));

  for (const file of [...ALL_HOOKS, ...libs.map((l) => join("lib", l))]) {
    it(`${file} passes bash -n`, () => {
      const r = run("bash", ["-n", join(HOOKS_DIR, file)]);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
    });
  }

  it("lib/hook-input.sh and lib/bash-cmd.sh exist", () => {
    expect(existsSync(join(HOOKS_DIR, "lib", "hook-input.sh"))).toBe(true);
    expect(existsSync(join(HOOKS_DIR, "lib", "bash-cmd.sh"))).toBe(true);
  });
});

describe(".claude/settings.json", () => {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf8"));

  function entries(event) {
    const groups = settings.hooks?.[event] ?? [];
    return groups.flatMap((g) => {
      expect(g.matcher).toBe("Bash");
      return g.hooks;
    });
  }

  it("wires every PreToolUse hook with a description and an existing script", () => {
    const wired = entries("PreToolUse");
    for (const h of wired) {
      expect(h.type).toBe("command");
      expect(h.description?.length ?? 0).toBeGreaterThan(10);
      const m = h.command.match(/^bash \.claude\/hooks\/([\w-]+\.sh)$/);
      expect(m, `unexpected command: ${h.command}`).not.toBeNull();
      expect(existsSync(join(HOOKS_DIR, m[1]))).toBe(true);
    }
    expect(wired.map((h) => h.command.split("/").pop()).sort()).toEqual([...PRE_HOOKS].sort());
  });

  it("wires every PostToolUse hook with a description and an existing script", () => {
    const wired = entries("PostToolUse");
    for (const h of wired) {
      expect(h.type).toBe("command");
      expect(h.description?.length ?? 0).toBeGreaterThan(10);
      const m = h.command.match(/^bash \.claude\/hooks\/([\w-]+\.sh)$/);
      expect(m, `unexpected command: ${h.command}`).not.toBeNull();
      expect(existsSync(join(HOOKS_DIR, m[1]))).toBe(true);
    }
    expect(wired.map((h) => h.command.split("/").pop()).sort()).toEqual([...POST_HOOKS].sort());
  });
});

// ---------------------------------------------------------------------------

describe("secret-guard.sh (PreToolUse)", () => {
  const blocks = [
    "git add .env",
    "git add -f secret.pem",
    "git add --force src/",
    "git add -Af src/",
    "git add api/.env.local",
    "git add config/credentials.json",
    "git add certs/server.key",
    "git add certs/client.p12",
    "git add .dev.vars",
    "git stage ./.env",
    'git add "api/.env"',
    "cd api && git add .env",
    "git add src/ ; git add .env",
    "git add src/ || git add .env",
    "(cd api && git add .env)",
    "git -C api add .env",
    "FOO=1 git add .env",
    "echo `git add .env`",
    "cat <<EOF > x\nfoo\nEOF\ngit add .env",
  ];
  for (const command of blocks) {
    it(`blocks: ${JSON.stringify(command)}`, () => {
      const r = runHook("secret-guard.sh", pre(command));
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("[secret-guard]");
      expect(r.stdout).toBe("");
    });
  }

  it("names the offending token", () => {
    expect(runHook("secret-guard.sh", pre("git add .env")).stderr).toContain("(.env)");
    expect(runHook("secret-guard.sh", pre("git add -f secret.pem")).stderr).toContain("(-f)");
    expect(runHook("secret-guard.sh", pre("git add api/.env.local")).stderr).toContain("api/.env.local");
  });

  const allows = [
    "git add .env.example",
    "git add .env.local.example",
    "git add src/",
    "git add .",
    "git add -- src",
    "git add src/env.ts",
    'git commit -m "add .env support"',
    'git commit -m "chore: git add .env to ignore"',
    'echo "git add .env"',
    "# git add .env",
    "cat <<'EOF' > notes.md\ngit add .env\nEOF\ngit status",
    "cat <<-EOF > notes.md\n\tgit add .env\n\tEOF\ngit status 2>&1",
    "git log --oneline | head",
    "git status && git diff",
    "ls -la",
  ];
  for (const command of allows) {
    it(`allows: ${JSON.stringify(command)}`, () => {
      const r = runHook("secret-guard.sh", pre(command));
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
    });
  }

  it("blocks commit -a / -am / --all when a secret file is tracked", () => {
    const repo = gitRepo({ ".env": "SECRET=1\n", "src/index.ts": "export {};\n" });
    for (const command of ['git commit -am "wip"', 'git commit -a -m "wip"', 'git commit --all -m "wip"']) {
      const r = runHook("secret-guard.sh", pre(command), { cwd: repo.dir });
      expect(r.exitCode, command).toBe(2);
      expect(r.stderr).toContain("[secret-guard]");
      expect(r.stderr).toContain(".env");
    }
  });

  it("allows commit -a when only .env.example is tracked, and plain commit anywhere", () => {
    const clean = gitRepo({ ".env.example": "SECRET=\n", "src/index.ts": "export {};\n" });
    expect(runHook("secret-guard.sh", pre('git commit -am "wip"'), { cwd: clean.dir }).exitCode).toBe(0);

    const dirty = gitRepo({ "certs/server.pem": "---\n" });
    expect(runHook("secret-guard.sh", pre('git commit -m "wip"'), { cwd: dirty.dir }).exitCode).toBe(0);
    expect(runHook("secret-guard.sh", pre('git commit -am "wip"'), { cwd: dirty.dir }).exitCode).toBe(2);
  });

  it("ignores non-Bash tools", () => {
    const r = runHook("secret-guard.sh", { tool_name: "Write", tool_input: { file_path: ".env", content: "x" } });
    expect(r.exitCode).toBe(0);
  });

  it("honours NERVA_SKIP_HOOKS=1 from the hook environment", () => {
    const r = runHook("secret-guard.sh", pre("git add .env"), { env: { NERVA_SKIP_HOOKS: "1" } });
    expect(r.exitCode).toBe(0);
  });

  it("works through the node JSON fallback", () => {
    const r = runHook("secret-guard.sh", pre("git add .env"), { env: { NERVA_HOOK_JSON_TOOL: "node" } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("(.env)");
  });
});

// ---------------------------------------------------------------------------

describe("prod-db-guard.sh (PreToolUse)", () => {
  const blocks = [
    ["wrangler secret put X && drizzle-kit push --env production", "production"],
    ["npx drizzle-kit push --env=production", "production"],
    ["DATABASE_URL=postgres://user@db.prod.internal/app pnpm drizzle-kit push", "prod"],
    ["NODE_ENV=production pnpm db:push", "NODE_ENV=production"],
    ['PROD_DATABASE_URL=postgres://x psql -c "TRUNCATE users"', "TRUNCATE"],
    ['psql "$PROD_DATABASE_URL" -c "DROP SCHEMA public CASCADE"', "DROP SCHEMA"],
    ['PROD_DATABASE_URL=postgres://x pnpm db:seed -- --sql "drop database app"', /drop database/i],
    ["drizzle-kit drop", "drop"],
    ["pnpm drizzle-kit drop", "drop"],
    ["cd api && npx drizzle-kit drop", "drop"],
  ];
  for (const [command, token] of blocks) {
    it(`blocks: ${JSON.stringify(command)}`, () => {
      const r = runHook("prod-db-guard.sh", pre(command));
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("[prod-db-guard]");
      if (token instanceof RegExp) expect(r.stderr).toMatch(token);
      else expect(r.stderr).toContain(token);
      expect(r.stdout).toBe("");
    });
  }

  const allows = [
    "drizzle-kit push",
    "pnpm drizzle-kit push",
    "pnpm db:push",
    "drizzle-kit generate",
    "pnpm drizzle-kit generate && pnpm drizzle-kit migrate",
    'psql $PROD_DATABASE_URL -c "SELECT count(*) FROM users"',
    "PROD_DATABASE_URL=postgres://x pnpm db:migrate",
    'psql dev -c "TRUNCATE users"',
    'git commit -m "docs: drop database section"',
    'echo "drizzle-kit drop"',
    'grep -r "drizzle-kit push" docs/',
    "pnpm test",
  ];
  for (const command of allows) {
    it(`allows: ${JSON.stringify(command)}`, () => {
      const r = runHook("prod-db-guard.sh", pre(command));
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
    });
  }

  it("honours NERVA_SKIP_HOOKS=1 from the hook environment", () => {
    const r = runHook("prod-db-guard.sh", pre("drizzle-kit drop"), { env: { NERVA_SKIP_HOOKS: "1" } });
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("coverage-check.sh (PostToolUse)", () => {
  const coverageTable = [
    "% Coverage report from v8",
    "-----------|---------|----------|---------|---------|",
    "File       | % Stmts | % Branch | % Funcs | % Lines |",
    "All files  |   91.2  |   80.5   |   88.9  |   91.2  |",
  ].join("\n");

  it("fires for vitest + coverage using tdd.coverageThreshold from NERVA_PIPELINE_CONFIG", () => {
    const env = configEnv({ tdd: { coverageThreshold: 85 } });
    const r = runHook("coverage-check.sh", post("pnpm vitest run --coverage", coverageTable), { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[coverage-check]");
    expect(r.stdout).toContain("85%");
    expect(r.stdout).toContain("91.2%");
    expect(r.stdout).toMatch(/meets/);
  });

  it("flags coverage below the threshold", () => {
    const env = configEnv({ tdd: { coverageThreshold: 85 } });
    const r = runHook("coverage-check.sh", post("vitest --coverage", "% Coverage report from v8\nAll files |   62.5 |   50 |"), { env });
    expect(r.stdout).toContain("62.5%");
    expect(r.stdout).toContain("BELOW");
    expect(r.stdout).toContain("85%");
  });

  it("falls back to 80% when the config file is missing", () => {
    const p = scratch();
    const env = { NERVA_PIPELINE_CONFIG: join(p.dir, "does-not-exist.json") };
    const r = runHook("coverage-check.sh", post("pnpm vitest run --coverage", "Coverage enabled with v8"), { env });
    expect(r.stdout).toContain("[coverage-check]");
    expect(r.stdout).toContain("80%");
  });

  it("accepts a string tool_response", () => {
    const env = configEnv({ tdd: { coverageThreshold: 90 } });
    const payload = { tool_name: "Bash", tool_input: { command: "vitest run --coverage" }, tool_response: "Coverage summary" };
    const r = runHook("coverage-check.sh", payload, { env });
    expect(r.stdout).toContain("90%");
  });

  it("reads coverage from stderr too", () => {
    const r = runHook("coverage-check.sh", post("pnpm vitest run --coverage", "", "Coverage enabled"));
    expect(r.stdout).toContain("[coverage-check]");
  });

  it("works through the node JSON fallback", () => {
    const env = { ...configEnv({ tdd: { coverageThreshold: 77 } }), NERVA_HOOK_JSON_TOOL: "node" };
    const r = runHook("coverage-check.sh", post("pnpm vitest run --coverage", coverageTable), { env });
    expect(r.stdout).toContain("77%");
  });

  it("stays silent for vitest without coverage output", () => {
    const r = runHook("coverage-check.sh", post("pnpm vitest run", "Tests  12 passed (12)"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("stays silent for non-vitest commands even when the output mentions coverage", () => {
    const r = runHook("coverage-check.sh", post("pnpm build", "Coverage: full"));
    expect(r.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("migration-safety-reminder.sh (PostToolUse)", () => {
  const generated = "[✓] Your SQL migration file ➜ drizzle/0001_bold_hulk.sql 🚀";

  it("after drizzle-kit generate in the framework repo, points at check-destructive-migrations.js", () => {
    const p = scratch();
    p.write("scripts/check-destructive-migrations.js", "// stub\n");
    const r = runHook("migration-safety-reminder.sh", post("pnpm drizzle-kit generate", generated), { cwd: p.dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[migration-safety]");
    expect(r.stdout).toContain("node scripts/check-destructive-migrations.js");
    expect(r.stdout).toMatch(/read the new SQL/i);
  });

  it("after drizzle-kit generate in a generated api/ project, points at pnpm db:check-destructive", () => {
    const p = scratch();
    p.write("package.json", JSON.stringify({ scripts: { "db:check-destructive": "node scripts/check-destructive.js" } }));
    const r = runHook("migration-safety-reminder.sh", post("pnpm db:generate", generated), { cwd: p.dir });
    expect(r.stdout).toContain("pnpm db:check-destructive");
    expect(r.stdout).not.toContain("node scripts/check-destructive-migrations.js");
  });

  it("stays silent when generate produced nothing or failed", () => {
    const p = scratch();
    p.write("scripts/check-destructive-migrations.js", "// stub\n");
    const none = runHook("migration-safety-reminder.sh", post("drizzle-kit generate", "No schema changes, nothing to migrate 😴"), { cwd: p.dir });
    expect(none.stdout).toBe("");
    const failed = runHook("migration-safety-reminder.sh", post("drizzle-kit generate", "", "Error: cannot find drizzle.config.ts"), { cwd: p.dir });
    expect(failed.stdout).toBe("");
    const empty = runHook("migration-safety-reminder.sh", post("drizzle-kit generate", ""), { cwd: p.dir });
    expect(empty.stdout).toBe("");
  });

  it("reminds that push is dev-only after any drizzle-kit push", () => {
    for (const command of ["drizzle-kit push", "pnpm drizzle-kit push --force", "pnpm db:push"]) {
      const r = runHook("migration-safety-reminder.sh", post(command, "[✓] Changes applied"));
      expect(r.exitCode, command).toBe(0);
      expect(r.stdout).toContain("[migration-safety]");
      expect(r.stdout).toMatch(/dev-only/);
      expect(r.stdout).toContain("migrate");
    }
  });

  it("stays silent for unrelated commands", () => {
    const r = runHook("migration-safety-reminder.sh", post("pnpm drizzle-kit studio", "Drizzle Studio is up"));
    expect(r.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("quality-gate-reminder.sh (PostToolUse)", () => {
  const passed = "Test Files  3 passed (3)\n     Tests  42 passed (42)\n  Duration  1.20s";

  it("fires when every vitest test passed, with the configured threshold", () => {
    const env = configEnv({ tdd: { coverageThreshold: 85 } });
    const r = runHook("quality-gate-reminder.sh", post("pnpm vitest run", passed), { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[quality-gate]");
    expect(r.stdout).toContain("./scripts/check-types.sh");
    expect(r.stdout).toContain("./scripts/security-scan.sh");
    expect(r.stdout).toContain("85%");
  });

  it("also fires for pnpm test and run-tests.sh", () => {
    expect(runHook("quality-gate-reminder.sh", post("pnpm test", passed)).stdout).toContain("[quality-gate]");
    expect(runHook("quality-gate-reminder.sh", post("./scripts/run-tests.sh", passed)).stdout).toContain("[quality-gate]");
  });

  it("stays silent when any test failed", () => {
    const r = runHook("quality-gate-reminder.sh", post("pnpm vitest run", "Tests  1 failed | 41 passed (42)"));
    expect(r.stdout).toBe("");
  });

  it("stays silent without a passing summary or for non-test commands", () => {
    expect(runHook("quality-gate-reminder.sh", post("pnpm vitest run", "compiling...")).stdout).toBe("");
    expect(runHook("quality-gate-reminder.sh", post("pnpm build", passed)).stdout).toBe("");
    expect(runHook("quality-gate-reminder.sh", post("pnpm vitest run", "")).stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("robustness: every hook fails open on bad input", () => {
  const badInputs = [
    ["empty stdin", ""],
    ["plain text", "not json at all"],
    ["empty object", "{}"],
    ["missing tool_input", JSON.stringify({ tool_name: "Bash" })],
    ["tool_input is a string", JSON.stringify({ tool_name: "Bash", tool_input: "git add .env" })],
    ["array", "[1,2,3]"],
    ["truncated JSON", '{"tool_name":"Bash","tool_input":{"command":"git add .env"'],
  ];

  for (const hook of ALL_HOOKS) {
    for (const [label, input] of badInputs) {
      it(`${hook} exits 0 silently on ${label}`, () => {
        const r = runHook(hook, input);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe("");
      });
    }
  }

  for (const hook of POST_HOOKS) {
    it(`${hook} exits 0 when tool_response is missing`, () => {
      const r = runHook(hook, { tool_name: "Bash", tool_input: { command: "pnpm vitest run --coverage && drizzle-kit generate" } });
      expect(r.exitCode).toBe(0);
    });
  }
});
