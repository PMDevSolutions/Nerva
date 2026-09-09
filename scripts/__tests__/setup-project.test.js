/**
 * Tests for scripts/setup-project.sh
 *
 * --dry-run drives the platform/structure assertions: it prints
 * "[DRY RUN] Would create/copy/generate/run: <path>" lines and touches
 * nothing. Full generation runs with a fake `pnpm` shim on PATH that records
 * its argv and exits 0, so package.json, pnpm-workspace.yaml, and every copied
 * template can be checked without network access. The script resolves the
 * target as $(pwd)/<name>, so every run uses the temp dir as cwd.
 *
 * setup-project.sh hardcodes ANSI colors (it does not honor NO_COLOR), so
 * output is stripped before matching.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { run, runBash, tmpProject, SCRIPTS_DIR, REPO_ROOT } from "./helpers.js";

const SCRIPT = join(SCRIPTS_DIR, "setup-project.sh");
const PNPM_VERSION = "10.99.0";

let tmp;
let root; // realpath of tmp.dir: the script prints $(pwd), which resolves macOS's /var symlink
let fakeBin;
let fakeLog;
let gitStatusBefore;

// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

beforeAll(() => {
  gitStatusBefore = run("git", ["status", "--porcelain"], { cwd: REPO_ROOT }).stdout;
  tmp = tmpProject("nerva-setup-");
  root = realpathSync(tmp.dir);
  fakeBin = join(root, "bin");
  fakeLog = join(root, "pnpm.log");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "pnpm"),
    `#!/usr/bin/env bash\necho "$*" >> "$FAKE_LOG"\n[[ "\${1:-}" == "--version" ]] && echo "${PNPM_VERSION}"\nexit 0\n`,
    { mode: 0o755 },
  );
});
afterAll(() => tmp.cleanup());

function setup(args, opts = {}) {
  const r = runBash(SCRIPT, args, {
    cwd: root,
    env: { PATH: `${fakeBin}:${process.env.PATH}`, FAKE_LOG: fakeLog },
    ...opts,
  });
  return { ...r, stdout: stripAnsi(r.stdout), stderr: stripAnsi(r.stderr) };
}

function dryRun(name, flags = []) {
  const r = setup([name, ...flags, "--dry-run"]);
  expect(r.exitCode, r.stderr).toBe(0);
  const target = join(root, name);
  const listed = (rel) => expect(r.stdout, rel).toContain(join(target, rel));
  const notListed = (rel) => expect(r.stdout, rel).not.toContain(join(target, rel));
  return { ...r, target, listed, notListed };
}

const pnpmCalls = () => readFileSync(fakeLog, "utf-8").trim().split("\n");
const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));

// Everything every platform gets (dirs, copied templates, generated files).
const SHARED_FILES = [
  "api/src/routes", "api/src/db/migrations", "api/src/middleware", "api/tests/unit", "api/tests/integration",
  "api/tsconfig.base.json", "api/tsconfig.json", "api/eslint.config.js", "api/prettier.config.js",
  "api/vitest.config.ts", "api/package.json", "api/pnpm-workspace.yaml", "api/drizzle.config.ts",
  "api/src/db/schema.ts", "api/src/db/client.ts", "api/src/db/schema-drift.ts", "api/tests/setup.ts",
  "api/tests/fixtures", "api/tests/fixtures/factory.ts", "api/tests/fixtures/index.ts", "api/tests/fixtures.test.ts",
  "api/scripts/check-destructive-migrations.mjs", ".github/workflows/schema-drift.yml",
  ".github/workflows/schema-applied.yml", "postman/collection.json", "postman/environment.json",
  "README.md", "api/.gitignore",
];

const DOCKER = ["api/Dockerfile", "api/docker-compose.yml", "api/.env.example"];
const PLATFORM_FILES = {
  cloudflare: ["api/wrangler.toml", "api/.dev.vars.example"],
  node: DOCKER,
  lambda: ["api/template.yaml", "api/samconfig.toml", "api/esbuild.config.mjs", ".github/workflows/deploy.yml",
    "api/docker-compose.yml", "api/.env.example"],
  railway: [...DOCKER, "api/railway.toml", "api/nixpacks.toml"],
  fly: [...DOCKER, "api/fly.toml"],
};
// Files that belong to exactly one platform (Dockerfile/.env.example are shared).
const EXCLUSIVE_FILES = [
  "api/wrangler.toml", "api/.dev.vars.example", "api/template.yaml", "api/samconfig.toml",
  "api/esbuild.config.mjs", ".github/workflows/deploy.yml", "api/railway.toml", "api/nixpacks.toml", "api/fly.toml",
];

describe("setup-project.sh", () => {
  it("passes bash -n syntax check", () => {
    const r = run("bash", ["-n", SCRIPT]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 1 with usage when the project name is missing", () => {
    const r = setup([]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ERROR] Missing project name.");
    expect(r.stdout).toContain("Usage:");
    for (const f of ["--cloudflare", "--node", "--lambda", "--railway", "--fly", "--multi-tenant", "--dry-run"]) {
      expect(r.stdout).toContain(f);
    }
  });

  it("rejects an unknown flag with exit 1", () => {
    const r = setup(["proj", "--bogus", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ERROR] Unknown option: --bogus");
    expect(existsSync(join(root, "proj"))).toBe(false);
  });

  it("defaults to the node platform when no platform flag is given", () => {
    const r = dryRun("default-proj");
    expect(r.stdout).toContain("(platform: node)");
    expect(r.stdout).toMatch(/Platform:\s+node/);
    for (const f of PLATFORM_FILES.node) r.listed(f);
    r.notListed("api/wrangler.toml");
  });

  it.each(Object.keys(PLATFORM_FILES))("--%s lists the platform files and the shared structure", (platform) => {
    const r = dryRun(`${platform}-proj`, [`--${platform}`]);
    expect(r.stdout).toContain(`(platform: ${platform})`);
    for (const f of SHARED_FILES) r.listed(f);
    for (const f of PLATFORM_FILES[platform]) r.listed(f);
    for (const f of EXCLUSIVE_FILES) {
      if (!PLATFORM_FILES[platform].includes(f)) r.notListed(f);
    }
    expect(r.stdout).toContain("Would run: pnpm add hono drizzle-orm postgres zod @hono/zod-validator");
    expect(r.stdout).toContain("Would run: pnpm add -D vitest typescript@^6 eslint prettier drizzle-kit");
    expect(r.stdout).toContain("Dry-run complete");
  });

  it("copies the cloudflare tsconfig only for --cloudflare", () => {
    const cf = dryRun("tsc-cf", ["--cloudflare"]);
    expect(cf.stdout).toContain(`shared/tsconfig.cloudflare.json → ${join(cf.target, "api/tsconfig.json")}`);
    expect(cf.stdout).toContain("Would run: pnpm add -D wrangler @cloudflare/workers-types");
    expect(cf.stdout).not.toContain("@hono/node-server");
    const node = dryRun("tsc-node", ["--node"]);
    expect(node.stdout).toContain(`shared/tsconfig.node.json → ${join(node.target, "api/tsconfig.json")}`);
    expect(node.stdout).toContain("Would run: pnpm add @hono/node-server");
  });

  it("--multi-tenant adds the tenancy files and reports the tenancy mode", () => {
    const r = dryRun("mt-proj", ["--node", "--multi-tenant"]);
    for (const f of ["config", "schema", "middleware", "row-scope", "schema-scope"]) {
      r.listed(`api/src/tenancy/${f}.ts`);
    }
    r.listed("api/src/db/rls-policies.sql");
    r.listed("api/tests/tenancy.test.ts");
    r.listed("api/tests/fixtures/tenancy.ts");
    expect(r.stdout).toContain(`Would append to: ${join(r.target, "api/tests/fixtures/index.ts")}`);
    expect(r.stdout).toContain(`Would append to: ${join(r.target, "api/.env.example")}`);
    expect(r.stdout).toMatch(/Tenancy:\s+multi-tenant/);
    const plain = dryRun("plain-proj", ["--node"]);
    plain.notListed("api/src/tenancy");
    plain.notListed("api/tests/tenancy.test.ts");
    plain.notListed("api/tests/fixtures/tenancy.ts");
    // cloudflare keeps its env in .dev.vars.example
    const cf = dryRun("mt-cf", ["--cloudflare", "--multi-tenant"]);
    expect(cf.stdout).toContain(`Would append to: ${join(cf.target, "api/.dev.vars.example")}`);
  });

  it("dry-run creates nothing on disk and runs no pnpm commands", () => {
    writeFileSync(fakeLog, "");
    const r = dryRun("ghost-proj", ["--lambda"]);
    expect(existsSync(r.target)).toBe(false);
    expect(pnpmCalls()).toEqual(["--version"]);
  });

  it("without pnpm on PATH: dry-run warns and exits 0, a real run exits 1 and creates nothing", () => {
    const dry = setup(["nopnpm-dry", "--dry-run"], { env: { PATH: "/usr/bin:/bin" } });
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("[WARN] pnpm is not installed.");
    const real = setup(["nopnpm-real"], { env: { PATH: "/usr/bin:/bin" } });
    expect(real.exitCode).toBe(1);
    expect(real.stderr).toContain("[ERROR] pnpm is not installed.");
    expect(existsSync(join(root, "nopnpm-real"))).toBe(false);
  });

  it("refuses to overwrite an existing target directory", () => {
    const target = join(root, "exists-already");
    mkdirSync(target);
    writeFileSync(fakeLog, "");
    const r = setup(["exists-already", "--node"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`[ERROR] Directory already exists: ${target}`);
    expect(existsSync(join(target, "api"))).toBe(false);
    expect(readFileSync(fakeLog, "utf-8")).toBe("");
    // --dry-run does not care that the directory exists
    expect(setup(["exists-already", "--node", "--dry-run"]).exitCode).toBe(0);
  });

  it("generates a complete --cloudflare project with the fake pnpm", () => {
    writeFileSync(fakeLog, "");
    const r = setup(["cf-real", "--cloudflare"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("Project created successfully!");
    const target = join(root, "cf-real");
    const api = join(target, "api");

    const pkg = readJson(join(api, "package.json"));
    expect(pkg.name).toBe("cf-real");
    expect(pkg.packageManager).toBe(`pnpm@${PNPM_VERSION}`);
    expect(pkg.scripts.deploy).toContain("Refusing bare deploy of the development environment");
    expect(pkg.scripts["deploy:staging"]).toContain("wrangler deploy --env staging");
    expect(pkg.scripts["deploy:production"]).toContain("wrangler deploy --env production");
    expect(pkg.scripts.build).toBe("wrangler deploy --dry-run --outdir dist");
    expect(pkg.scripts.dev).toBe("tsx watch src/index.ts");
    expect(pkg.scripts["db:check-destructive"]).toBe("node scripts/check-destructive-migrations.mjs");
    expect(pkg.scripts["db:check-drift"]).toBe("tsx src/db/schema-drift.ts");
    expect(pkg.scripts["db:check-drift:strict"]).toBe("tsx src/db/schema-drift.ts --strict");

    const ws = readFileSync(join(api, "pnpm-workspace.yaml"), "utf-8");
    expect(ws).toContain("onlyBuiltDependencies:\n  - esbuild\n  - workerd\n");
    expect(ws).toContain("allowBuilds:\n  esbuild: true\n  workerd: true\n");

    const calls = pnpmCalls();
    expect(calls).toContain("add hono drizzle-orm postgres zod @hono/zod-validator");
    expect(calls).toContain("add -D wrangler @cloudflare/workers-types");
    expect(calls.some((c) => c.startsWith("add -D vitest typescript@^6 eslint"))).toBe(true);
    expect(calls).not.toContain("add @hono/node-server");

    for (const f of [...SHARED_FILES, ...PLATFORM_FILES.cloudflare]) {
      expect(existsSync(join(target, f)), f).toBe(true);
    }
    expect(readFileSync(join(api, "tsconfig.json"), "utf-8")).toBe(
      readFileSync(join(REPO_ROOT, "templates/shared/tsconfig.cloudflare.json"), "utf-8"),
    );
    expect(readFileSync(join(api, "drizzle.config.ts"), "utf-8")).toContain("schema: './src/db/schema.ts',");
    expect(readFileSync(join(api, ".dev.vars.example"), "utf-8")).toContain("JWT_SECRET=");
    expect(readFileSync(join(api, "scripts/check-destructive-migrations.mjs"), "utf-8")).toBe(
      readFileSync(join(SCRIPTS_DIR, "check-destructive-migrations.js"), "utf-8"),
    );
    const collection = readJson(join(target, "postman/collection.json"));
    expect(collection.info.name).toBe("cf-real");
    expect(collection.variable.find((v) => v.key === "base_url").value).toBe("http://localhost:8787");
    expect(readJson(join(target, "postman/environment.json")).name).toBe("cf-real (local)");
    const readme = readFileSync(join(target, "README.md"), "utf-8");
    expect(readme).toContain("# cf-real");
    expect(readme).toContain("## Deploying to Cloudflare Workers");
    expect(readme).toContain("## Migration safety");
    expect(readme).not.toContain("## Multi-tenancy");
  });

  it("generates a --node --multi-tenant project with tsc build and tenancy wiring", () => {
    writeFileSync(fakeLog, "");
    const r = setup(["node-real", "--node", "--multi-tenant"]);
    expect(r.exitCode, r.stderr).toBe(0);
    const target = join(root, "node-real");
    const api = join(target, "api");

    const pkg = readJson(join(api, "package.json"));
    expect(pkg.scripts.build).toBe("tsc");
    expect(pkg.scripts.deploy).toBeUndefined();
    expect(pkg.scripts["db:check-destructive"]).toBeDefined();
    expect(pkg.scripts["db:check-drift"]).toBeDefined();
    const ws = readFileSync(join(api, "pnpm-workspace.yaml"), "utf-8");
    expect(ws).toContain("- esbuild");
    expect(ws).not.toContain("workerd");
    expect(pnpmCalls()).toContain("add @hono/node-server");

    for (const f of [...PLATFORM_FILES.node, "api/src/tenancy/middleware.ts", "api/src/db/rls-policies.sql", "api/tests/tenancy.test.ts"]) {
      expect(existsSync(join(target, f)), f).toBe(true);
    }
    expect(existsSync(join(api, "wrangler.toml"))).toBe(false);
    expect(readFileSync(join(api, "drizzle.config.ts"), "utf-8")).toContain(
      "schema: ['./src/db/schema.ts', './src/tenancy/schema.ts'],",
    );
    const env = readFileSync(join(api, ".env.example"), "utf-8");
    expect(env).toContain("PORT=3000");
    expect(env).toContain("TENANCY_STRATEGY=row");
    expect(readFileSync(join(target, "README.md"), "utf-8")).toContain("## Multi-tenancy");
    expect(readJson(join(target, "postman/collection.json")).variable[0].value).toBe("http://localhost:3000");
  });

  it("leaves the real repo untouched", () => {
    expect(run("git", ["status", "--porcelain"], { cwd: REPO_ROOT }).stdout).toBe(gitStatusBefore);
  });
});
