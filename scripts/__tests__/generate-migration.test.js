import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { run, runBash, tmpProject, SCRIPTS_DIR } from "./helpers.js";

const SCRIPT = join(SCRIPTS_DIR, "generate-migration.sh");

describe("generate-migration.sh", () => {
  let project;

  beforeAll(() => {
    project = tmpProject("nerva-genmig-");
  });

  afterAll(() => project.cleanup());

  it("passes bash -n syntax check", () => {
    const r = run("bash", ["-n", SCRIPT]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("prints usage and exits 0 with --help", () => {
    const r = runBash(SCRIPT, ["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("--apply");
    expect(r.stdout).toContain("nerva:allow-destructive:");
  });

  it("exits 1 with a clear message when the API directory is missing", () => {
    const missing = join(project.dir, "no-such-api");
    const r = runBash(SCRIPT, [], { env: { NERVA_API_DIR: missing } });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ERROR] API directory not found at:");
    expect(r.stderr).toContain(missing);
  });

  it("exits 1 when drizzle.config.ts is missing from the API directory", () => {
    project.write("api-no-drizzle/.keep", "");
    const r = runBash(SCRIPT, ["add_users"], {
      env: { NERVA_API_DIR: join(project.dir, "api-no-drizzle") },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("drizzle.config.ts not found");
  });

  it("exits 1 when dependencies are not installed", () => {
    project.write("api-no-deps/drizzle.config.ts", "export default {};\n");
    const r = runBash(SCRIPT, ["add_users"], {
      env: { NERVA_API_DIR: join(project.dir, "api-no-deps") },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Dependencies not installed");
  });

  it("rejects unknown options with exit 1 and usage", () => {
    const r = runBash(SCRIPT, ["--bogus"], { env: { NERVA_API_DIR: project.dir } });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown option: --bogus");
    expect(r.stderr).toContain("Usage:");
  });
});
