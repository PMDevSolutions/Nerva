#!/usr/bin/env node
/**
 * validate-pipeline-config.js — Validate .claude/pipeline.config.json against
 * .claude/pipeline.config.schema.json (JSON Schema draft 2020-12), then run the
 * structural checks the schema cannot express:
 *
 *   - every orchestration.phases[*].depends entry names an existing phase
 *   - the phase graph has no dependency cycles (topological sort)
 *   - every phase with blocking: true is reachable (all of its transitive
 *     dependencies exist and are acyclic)
 *   - orchestration.qualityGateSubtasks is non-empty when orchestration.enabled
 *   - deployment.defaultTarget appears in deployment.targets
 *   - version is a semver string
 *   - WARN (never fail) when tdd.coverageThreshold differs from
 *     qualityGate.coverageThreshold
 *
 * Usage:
 *   node scripts/validate-pipeline-config.js
 *   node scripts/validate-pipeline-config.js --config <path> --schema <path>
 *   node scripts/validate-pipeline-config.js --json
 *
 * The config path falls back to NERVA_PIPELINE_CONFIG (the same override
 * scripts/lib/pipeline-config.js honors) before the repo default.
 *
 * Exit codes:
 *   0 — config is valid (warnings allowed)
 *   1 — config has schema or structural errors
 *   2 — usage or IO error (bad flag, file missing, JSON parse failure, ajv missing)
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

export const DEFAULT_CONFIG = join(repoRoot, ".claude", "pipeline.config.json");
export const DEFAULT_SCHEMA = join(repoRoot, ".claude", "pipeline.config.schema.json");

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

class UsageError extends Error {}

function printHelp() {
  console.log(`Usage: node scripts/validate-pipeline-config.js [options]

Validate .claude/pipeline.config.json against its JSON Schema and run
structural checks (phase graph, deployment targets, version).

Options:
  --config <path>   Config to validate (default: NERVA_PIPELINE_CONFIG or
                    .claude/pipeline.config.json)
  --schema <path>   Schema to validate against
                    (default: .claude/pipeline.config.schema.json)
  --json            Emit {valid, errors:[{path,message}], warnings:[...]} as JSON
  -h, --help        Show this message

Exit codes: 0 valid, 1 invalid, 2 usage/IO error`);
}

export function parseArgs(argv) {
  const out = {
    config: process.env.NERVA_PIPELINE_CONFIG
      ? resolve(process.env.NERVA_PIPELINE_CONFIG)
      : DEFAULT_CONFIG,
    schema: DEFAULT_SCHEMA,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "--schema") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${a} requires a path argument`);
      }
      out[a.slice(2)] = resolve(value);
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "-h" || a === "--help") {
      out.help = true;
    } else {
      throw new UsageError(`Unknown argument: ${a}`);
    }
  }
  return out;
}

function loadJson(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found at ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`Failed to parse ${label} (${path}): ${e.message}`, { cause: e });
  }
}

/** Convert an ajv error into {path, message} with a JSON-pointer path. */
export function formatSchemaError(err) {
  const path = err.instancePath || "/";
  let message = err.message ?? "validation failed";
  const p = err.params ?? {};
  if (p.additionalProperty !== undefined) {
    message = `unexpected property "${p.additionalProperty}"`;
  } else if (p.missingProperty !== undefined) {
    message = `missing required property "${p.missingProperty}"`;
  } else if (p.allowedValues !== undefined) {
    message = `${message}: ${p.allowedValues.map((v) => JSON.stringify(v)).join(", ")}`;
  } else if (err.keyword === "propertyName" && p.propertyName !== undefined) {
    message = `property name "${p.propertyName}" is invalid`;
  }
  return { path, message };
}

/**
 * Structural checks. Returns { errors: [{path, message}], warnings: [{path, message}] }.
 * `skipVersion` suppresses the semver check when the schema already reported /version.
 */
export function structuralChecks(config, { skipVersion = false } = {}) {
  const errors = [];
  const warnings = [];
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  // 1. version is semver
  if (!skipVersion) {
    if (typeof config.version !== "string" || !SEMVER_RE.test(config.version)) {
      errors.push({
        path: "/version",
        message: `must be a semver string (MAJOR.MINOR.PATCH), got ${JSON.stringify(config.version)}`,
      });
    }
  }

  // 2. Orchestration phase graph
  const orchestration = isObject(config.orchestration) ? config.orchestration : null;
  const phases = orchestration && isObject(orchestration.phases) ? orchestration.phases : null;
  if (phases) {
    const names = new Set(Object.keys(phases));
    const depsOf = (name) => {
      const d = phases[name]?.depends;
      return Array.isArray(d) ? d.filter((x) => typeof x === "string") : [];
    };

    for (const name of names) {
      for (const dep of depsOf(name)) {
        if (!names.has(dep)) {
          errors.push({
            path: `/orchestration/phases/${name}/depends`,
            message: `references unknown phase "${dep}"`,
          });
        }
        if (dep === name) {
          errors.push({
            path: `/orchestration/phases/${name}/depends`,
            message: `phase depends on itself`,
          });
        }
      }
    }

    // Kahn's algorithm over edges to existing phases only, so a missing
    // dependency is reported once (above) rather than also as a cycle.
    const indegree = new Map([...names].map((n) => [n, 0]));
    const dependents = new Map([...names].map((n) => [n, []]));
    for (const name of names) {
      for (const dep of depsOf(name)) {
        if (names.has(dep)) {
          indegree.set(name, indegree.get(name) + 1);
          dependents.get(dep).push(name);
        }
      }
    }
    const queue = [...names].filter((n) => indegree.get(n) === 0);
    const ordered = [];
    while (queue.length) {
      const n = queue.shift();
      ordered.push(n);
      for (const m of dependents.get(n)) {
        indegree.set(m, indegree.get(m) - 1);
        if (indegree.get(m) === 0) queue.push(m);
      }
    }
    const inCycle = [...names].filter((n) => !ordered.includes(n));
    if (inCycle.length) {
      errors.push({
        path: "/orchestration/phases",
        message: `dependency cycle detected involving: ${inCycle.join(", ")}`,
      });
    }

    // Reachability: a phase is reachable when it is not in a cycle and every
    // transitive dependency exists. Blocking phases must be reachable.
    const reachable = new Map();
    const isReachable = (name, seen = new Set()) => {
      if (reachable.has(name)) return reachable.get(name);
      if (!names.has(name) || inCycle.includes(name) || seen.has(name)) return false;
      seen.add(name);
      const ok = depsOf(name).every((d) => isReachable(d, seen));
      reachable.set(name, ok);
      return ok;
    };
    for (const name of names) {
      if (phases[name]?.blocking === true && !isReachable(name)) {
        errors.push({
          path: `/orchestration/phases/${name}`,
          message: `blocking phase is unreachable (a dependency is missing or cyclic)`,
        });
      }
    }
  }

  // 3. qualityGateSubtasks non-empty when orchestration is enabled
  if (orchestration && orchestration.enabled === true) {
    const subtasks = orchestration.qualityGateSubtasks;
    if (!isObject(subtasks) || Object.keys(subtasks).length === 0) {
      errors.push({
        path: "/orchestration/qualityGateSubtasks",
        message: "must define at least one subtask when orchestration.enabled is true",
      });
    }
  }

  // 4. deployment.defaultTarget ∈ deployment.targets
  const deployment = isObject(config.deployment) ? config.deployment : null;
  if (deployment && deployment.defaultTarget !== undefined && Array.isArray(deployment.targets)) {
    if (!deployment.targets.includes(deployment.defaultTarget)) {
      errors.push({
        path: "/deployment/defaultTarget",
        message: `"${deployment.defaultTarget}" is not listed in /deployment/targets (${deployment.targets.join(", ")})`,
      });
    }
  }

  // 5. Coverage threshold drift (warning only)
  const tddCoverage = config.tdd?.coverageThreshold;
  const gateCoverage = config.qualityGate?.coverageThreshold;
  if (tddCoverage !== undefined && gateCoverage !== undefined && tddCoverage !== gateCoverage) {
    warnings.push({
      path: "/tdd/coverageThreshold",
      message: `differs from /qualityGate/coverageThreshold (${tddCoverage} vs ${gateCoverage}); the TDD phase and the quality gate will disagree`,
    });
  }

  return { errors, warnings };
}

/**
 * Validate a config object against a schema object. Returns
 * { valid, errors, warnings }. Ajv2020 is passed in so callers control loading.
 */
export function validateConfig(config, schema, Ajv2020) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const schemaOk = validate(config);
  const schemaErrors = (validate.errors ?? []).map(formatSchemaError);
  const versionFlagged = schemaErrors.some((e) => e.path === "/version");
  const structural = structuralChecks(config, { skipVersion: versionFlagged });
  const errors = [...schemaErrors, ...structural.errors];
  return {
    valid: schemaOk && structural.errors.length === 0,
    errors,
    warnings: structural.warnings,
  };
}

function emitFailure(args, message, exitCode) {
  if (args?.json) {
    console.log(JSON.stringify({ valid: false, errors: [{ path: "/", message }], warnings: [] }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(exitCode);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`Error: ${e.message}\n`);
    printHelp();
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let config;
  let schema;
  try {
    config = loadJson(args.config, "Config");
    schema = loadJson(args.schema, "Schema");
  } catch (e) {
    emitFailure(args, e.message, 2);
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    emitFailure(args, `Config root must be a JSON object (${args.config})`, 2);
  }

  let Ajv2020;
  try {
    ({ default: Ajv2020 } = await import("ajv/dist/2020.js"));
  } catch {
    emitFailure(args, "ajv is not installed. Run `pnpm install` and retry.", 2);
  }

  const result = validateConfig(config, schema, Ajv2020);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Validating ${args.config}`);
    console.log(`Against    ${args.schema}`);
    console.log("");
    if (result.errors.length) {
      console.log(`Errors (${result.errors.length}):`);
      for (const e of result.errors) console.log(`  ${e.path}: ${e.message}`);
    }
    if (result.warnings.length) {
      console.log(`Warnings (${result.warnings.length}):`);
      for (const w of result.warnings) console.log(`  ${w.path}: ${w.message}`);
    }
    if (result.valid) {
      const sections = Object.keys(config).filter((k) => !k.startsWith("$")).length;
      const suffix = result.warnings.length ? ` with ${result.warnings.length} warning(s)` : "";
      console.log(`VALID: pipeline config passes (${sections} top-level sections)${suffix}`);
    } else {
      console.log(`INVALID: fix ${result.errors.length} error(s) and re-run.`);
    }
  }

  process.exit(result.valid ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error(`Error: ${e.stack ?? e.message}`);
    process.exit(2);
  });
}
