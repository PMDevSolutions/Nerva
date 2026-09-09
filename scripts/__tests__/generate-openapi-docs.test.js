/**
 * Tests for scripts/generate-openapi-docs.sh
 *
 * The script runs `npx tsx src/openapi.ts` in the API project (NERVA_API_DIR)
 * and converts the result with `npx ... openapi2postmanv2`. Both go through a
 * fake `npx` on PATH that logs its argv and either prints a spec (tsx) or
 * fails (postman conversion). The Postman output path is hardwired to
 * <repo>/postman/collection.json with no override, so the conversion is always
 * made to fail here to keep the real repo clean; only the skip path is
 * asserted. The script also `mkdir -p`s <repo>/postman regardless, so that
 * empty directory is removed afterwards if this run created it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "fs";
import { run, runBash, tmpProject, SCRIPTS_DIR, REPO_ROOT } from "./helpers.js";

const SCRIPT = join(SCRIPTS_DIR, "generate-openapi-docs.sh");
const REPO_POSTMAN = join(REPO_ROOT, "postman");
const FAKE_SPEC = "openapi: 3.1.0\ninfo:\n  title: Fake API\n  version: 9.9.9\npaths: {}\n";

let tmp;
let fakeBin;
let fakeLog;
let gitStatusBefore;
let postmanExistedBefore;

beforeAll(() => {
  gitStatusBefore = run("git", ["status", "--porcelain"], { cwd: REPO_ROOT }).stdout;
  postmanExistedBefore = existsSync(REPO_POSTMAN);
  tmp = tmpProject("nerva-openapi-");
  fakeBin = join(tmp.dir, "bin");
  fakeLog = join(tmp.dir, "calls.log");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "npx"),
    [
      "#!/usr/bin/env bash",
      'echo "npx $*" >> "$FAKE_LOG"',
      'if [[ "$1" == "tsx" ]]; then',
      '  [[ "${FAKE_TSX_FAIL:-0}" == 1 ]] && { echo "tsx exploded" >&2; exit 1; }',
      `  printf '%b' "${FAKE_SPEC.replace(/\n/g, "\\n")}"`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(join(fakeBin, "pnpm"), '#!/usr/bin/env bash\necho "pnpm $*" >> "$FAKE_LOG"\nexit 0\n', {
    mode: 0o755,
  });
});

afterAll(() => {
  tmp.cleanup();
  if (!postmanExistedBefore && existsSync(REPO_POSTMAN) && readdirSync(REPO_POSTMAN).length === 0) {
    rmdirSync(REPO_POSTMAN);
  }
});

/** Create a fake API project dir (the script expects src/ to exist); returns its absolute path. */
function apiDir(name, { nodeModules = true, yaml = true } = {}) {
  const dir = join(tmp.dir, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  if (nodeModules) mkdirSync(join(dir, "node_modules"), { recursive: true });
  if (yaml) mkdirSync(join(dir, "node_modules", "yaml"), { recursive: true });
  return dir;
}

function gen(api, args = [], env = {}) {
  writeFileSync(fakeLog, "");
  return runBash(SCRIPT, args, {
    env: { NERVA_API_DIR: api, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_LOG: fakeLog, ...env },
  });
}

const calls = () => readFileSync(fakeLog, "utf-8").trim().split("\n").filter(Boolean);

describe("generate-openapi-docs.sh", () => {
  it("passes bash -n syntax check", () => {
    const r = run("bash", ["-n", SCRIPT]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("rejects unknown options with exit 1", () => {
    const r = gen(apiDir("api-opt"), ["--bogus"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ERROR] Unknown option: --bogus");
  });

  it("exits 1 when the API directory is missing", () => {
    const missing = join(tmp.dir, "no-such-api");
    const r = gen(missing);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`[ERROR] API directory not found at: ${missing}`);
  });

  it("exits 1 when node_modules is missing", () => {
    const r = gen(apiDir("api-no-deps", { nodeModules: false, yaml: false }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ERROR] Dependencies not installed. Run pnpm install first.");
    expect(calls()).toEqual([]);
  });

  it("creates src/openapi.ts, writes the spec to --output, and skips Postman when conversion fails", () => {
    const api = apiDir("api-ok");
    const out = join(tmp.dir, "out", "docs", "openapi.yaml");
    const r = gen(api, ["--output", out]);
    expect(r.exitCode, r.stderr).toBe(0);

    expect(r.stdout).toContain("[INFO] Creating OpenAPI generator script...");
    const generator = join(api, "src", "openapi.ts");
    expect(r.stdout).toContain(`[OK] Generator script created at: ${generator}`);
    const gensrc = readFileSync(generator, "utf-8");
    expect(gensrc).toContain("import { stringify } from 'yaml';");
    expect(gensrc).toContain("openapi: '3.1.0'");
    expect(gensrc).toContain("'/health'");

    expect(readFileSync(out, "utf-8")).toBe(FAKE_SPEC);
    expect(r.stdout).toContain(`[OK] OpenAPI spec written to: ${out}`);
    expect(r.stdout).toContain(`[INFO] Spec size: ${FAKE_SPEC.length} bytes`);
    expect(r.stdout).not.toContain("Fallback spec");

    expect(r.stdout).toContain("[WARN] Could not regenerate the Postman collection");
    expect(existsSync(join(REPO_POSTMAN, "collection.json"))).toBe(false);

    const log = calls();
    expect(log[0]).toBe(`npx tsx ${generator}`);
    expect(log[1]).toBe(
      `npx --yes --package=openapi-to-postmanv2 openapi2postmanv2 -s ${out} -o ${join(REPO_POSTMAN, "collection.json")} -p -O folderStrategy=Tags`,
    );
    expect(log.some((l) => l.startsWith("pnpm"))).toBe(false);
  });

  it("keeps an existing src/openapi.ts and installs yaml when it is missing", () => {
    const api = apiDir("api-custom", { yaml: false });
    const custom = "// custom generator\nconsole.log('custom');\n";
    tmp.write("api-custom/src/openapi.ts", custom);
    const out = join(tmp.dir, "out", "custom.yaml");
    const r = gen(api, ["-o", out]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("Creating OpenAPI generator script");
    expect(readFileSync(join(api, "src", "openapi.ts"), "utf-8")).toBe(custom);
    expect(r.stdout).toContain("[INFO] Installing yaml package...");
    expect(calls()[0]).toBe("pnpm add -D yaml");
    expect(readFileSync(out, "utf-8")).toBe(FAKE_SPEC);
  });

  it("writes the fallback spec and still exits 0 when tsx fails", () => {
    const api = apiDir("api-fallback");
    const out = join(tmp.dir, "out", "fallback.yaml");
    const r = gen(api, ["--output", out], { FAKE_TSX_FAIL: "1" });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("[WARN] Dynamic extraction failed. Writing minimal spec...");
    expect(r.stdout).toContain(`[OK] Fallback spec written to: ${out}`);
    const spec = readFileSync(out, "utf-8");
    expect(spec).toContain('openapi: "3.1.0"');
    expect(spec).toContain("title: Nerva API");
    expect(spec).toContain("/health:");
    expect(spec).not.toContain("Fake API");
    // The fallback still feeds the Postman conversion.
    expect(calls()[1]).toContain(`openapi2postmanv2 -s ${out}`);
  });

  it("leaves the real repo untouched", () => {
    expect(run("git", ["status", "--porcelain"], { cwd: REPO_ROOT }).stdout).toBe(gitStatusBefore);
    expect(existsSync(join(REPO_ROOT, "docs", "openapi.yaml"))).toBe(false);
  });
});
