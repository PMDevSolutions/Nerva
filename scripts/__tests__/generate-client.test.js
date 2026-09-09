/**
 * Tests for scripts/generate-client.sh
 *
 * The script shells out to `npx openapi-typescript` (version probe, then the
 * generation) and `pnpm list openapi-fetch` from inside NERVA_API_DIR. Both
 * are fake shims on PATH that log their argv; the openapi-typescript fake
 * writes a stub .d.ts to whatever `-o` path it is given. Relative --spec and
 * --output paths resolve against the framework repo root, so every path here
 * is absolute and inside the temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { run, runBash, tmpProject, SCRIPTS_DIR, REPO_ROOT } from "./helpers.js";

const SCRIPT = join(SCRIPTS_DIR, "generate-client.sh");
const STUB_TYPES = "export interface paths { '/health': unknown }\nexport interface components {}\nexport interface operations {}\n";

let tmp;
let api;
let spec;
let fakeBin;
let fakeLog;
let gitStatusBefore;

beforeAll(() => {
  gitStatusBefore = run("git", ["status", "--porcelain"], { cwd: REPO_ROOT }).stdout;
  tmp = tmpProject("nerva-client-");
  api = join(tmp.dir, "api");
  mkdirSync(api, { recursive: true });
  spec = tmp.write("docs/openapi.yaml", "openapi: 3.1.0\ninfo:\n  title: T\n  version: 1.0.0\npaths: {}\n");
  fakeBin = join(tmp.dir, "bin");
  fakeLog = join(tmp.dir, "calls.log");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "npx"),
    [
      "#!/usr/bin/env bash",
      'echo "npx $*" >> "$FAKE_LOG"',
      '[[ "$1" == "openapi-typescript" ]] || exit 1',
      'if [[ "$2" == "--version" ]]; then',
      '  [[ "${FAKE_OTS_MISSING:-0}" == 1 ]] && exit 1',
      '  echo "7.0.0"; exit 0',
      "fi",
      '[[ "${FAKE_OTS_FAIL:-0}" == 1 ]] && { echo "generation exploded" >&2; exit 1; }',
      'out=""; prev=""',
      'for a in "$@"; do [[ "$prev" == "-o" ]] && out="$a"; prev="$a"; done',
      `printf '%b' "${STUB_TYPES.replace(/\n/g, "\\n")}" > "$out"`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(fakeBin, "pnpm"),
    [
      "#!/usr/bin/env bash",
      'echo "pnpm $*" >> "$FAKE_LOG"',
      '[[ "$1" == "list" && "${FAKE_FETCH_MISSING:-0}" == 1 ]] && exit 1',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
});
afterAll(() => tmp.cleanup());

function gen(args = [], env = {}) {
  writeFileSync(fakeLog, "");
  return runBash(SCRIPT, args, {
    env: { NERVA_API_DIR: api, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_LOG: fakeLog, ...env },
  });
}

const calls = () => readFileSync(fakeLog, "utf-8").trim().split("\n").filter(Boolean);
const outDir = (name) => join(tmp.dir, "out", name);

describe("generate-client.sh", () => {
  it("passes bash -n syntax check", () => {
    const r = run("bash", ["-n", SCRIPT]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("prints usage and exits 0 with --help", () => {
    const r = gen(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
    for (const opt of ["--spec, -s", "--output, -o", "--runtime"]) expect(r.stdout).toContain(opt);
    expect(calls()).toEqual([]);
  });

  it("rejects unknown options with exit 1", () => {
    const r = gen(["--bogus"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ERROR] Unknown option: --bogus");
  });

  it("exits 1 with a hint when the spec is missing", () => {
    const missing = join(tmp.dir, "nope.yaml");
    const r = gen(["--spec", missing, "--output", outDir("never")]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`[ERROR] OpenAPI spec not found at: ${missing}`);
    expect(r.stdout).toContain("Generate it first: ./scripts/generate-openapi-docs.sh");
    expect(existsSync(outDir("never"))).toBe(false);
    expect(calls()).toEqual([]);
  });

  it("resolves a relative --spec against the framework repo root", () => {
    const r = gen(["--spec", "no/such/openapi.yaml", "--output", outDir("never2")]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`spec not found at: ${join(REPO_ROOT, "no/such/openapi.yaml")}`);
  });

  it("generates api-types.d.ts and index.ts (types only by default)", () => {
    const out = outDir("client");
    const r = gen(["--spec", spec, "--output", out]);
    expect(r.exitCode, r.stderr).toBe(0);

    const types = join(out, "api-types.d.ts");
    expect(readFileSync(types, "utf-8")).toBe(STUB_TYPES);
    expect(r.stdout).toContain(`[OK] Types generated at: ${types}`);

    const index = readFileSync(join(out, "index.ts"), "utf-8");
    expect(index).toContain("export type { paths, components, operations } from './api-types.js';");
    expect(index).not.toContain("client.js");
    expect(existsSync(join(out, "client.ts"))).toBe(false);

    expect(calls()).toEqual(["npx openapi-typescript --version", `npx openapi-typescript ${spec} -o ${types}`]);
    expect(r.stdout).toContain("Client generation complete!");
    expect(r.stdout).toContain("import type { paths } from 'client';");
    expect(r.stdout).not.toContain("client.GET");
  });

  it("--runtime also writes client.ts and re-exports it from index.ts", () => {
    const out = outDir("client-rt");
    const r = gen(["-s", spec, "-o", out, "--runtime"]);
    expect(r.exitCode, r.stderr).toBe(0);

    const client = readFileSync(join(out, "client.ts"), "utf-8");
    expect(client).toContain("import createClient from 'openapi-fetch';");
    expect(client).toContain("import type { paths } from './api-types.js';");
    expect(client).toContain("export const client = createClient<paths>(");
    expect(client).toContain("export function createApiClient(");
    expect(client).toContain("headers['Authorization'] = `Bearer ${options.token}`;");

    const index = readFileSync(join(out, "index.ts"), "utf-8");
    expect(index).toContain("export type { paths, components, operations } from './api-types.js';");
    expect(index).toContain("export { client, createApiClient } from './client.js';");
    expect(existsSync(join(out, "api-types.d.ts"))).toBe(true);

    expect(calls()).toContain("pnpm list openapi-fetch");
    expect(calls()).not.toContain("pnpm add openapi-fetch");
    expect(r.stdout).toContain(`[OK] Runtime client generated at: ${join(out, "client.ts")}`);
    expect(r.stdout).toContain("import { client } from 'client-rt';");
    expect(r.stdout).toContain("const { data } = await client.GET('/health');");
  });

  it("installs openapi-typescript and openapi-fetch only when they are missing", () => {
    const r = gen(["-s", spec, "-o", outDir("client-install"), "--runtime"], {
      FAKE_OTS_MISSING: "1",
      FAKE_FETCH_MISSING: "1",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("[INFO] Installing openapi-typescript...");
    expect(r.stdout).toContain("[INFO] Installing openapi-fetch...");
    const log = calls();
    expect(log.indexOf("pnpm add -D openapi-typescript")).toBeGreaterThan(log.indexOf("npx openapi-typescript --version"));
    expect(log.indexOf("pnpm add openapi-fetch")).toBeGreaterThan(log.indexOf("pnpm list openapi-fetch"));
  });

  it("exits 1 and writes no index.ts when type generation fails", () => {
    const out = outDir("client-fail");
    const r = gen(["-s", spec, "-o", out], { FAKE_OTS_FAIL: "1" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ERROR] Type generation failed.");
    expect(existsSync(join(out, "index.ts"))).toBe(false);
    expect(existsSync(join(out, "client.ts"))).toBe(false);
  });

  it("leaves the real repo untouched", () => {
    expect(run("git", ["status", "--porcelain"], { cwd: REPO_ROOT }).stdout).toBe(gitStatusBefore);
    expect(existsSync(join(REPO_ROOT, "client"))).toBe(false);
  });
});
