/**
 * Shared helpers for scripts/__tests__.
 *
 * run(cmd, args, opts) shells out with NO_COLOR set and returns
 * { stdout, stderr, exitCode } without throwing on non-zero exit.
 */
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

export const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = resolve(TESTS_DIR, "..");
export const REPO_ROOT = resolve(SCRIPTS_DIR, "..");
export const HOOKS_DIR = join(REPO_ROOT, ".claude", "hooks");

export function run(cmd, args = [], opts = {}) {
  const { cwd = REPO_ROOT, env = {}, input, timeout = 60000 } = opts;
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf-8",
      cwd,
      timeout,
      input,
      env: { ...process.env, NO_COLOR: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      exitCode: typeof err.status === "number" ? err.status : 1,
    };
  }
}

export function runBash(scriptPath, args = [], opts = {}) {
  return run("bash", [scriptPath, ...args], opts);
}

export function runNode(scriptPath, args = [], opts = {}) {
  return run("node", [scriptPath, ...args], opts);
}

/** Create a throwaway directory; call the returned cleanup() in afterAll/afterEach. */
export function tmpProject(prefix = "nerva-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    write(relPath, content) {
      const full = join(dir, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      return full;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
