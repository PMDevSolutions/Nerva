#!/usr/bin/env node
/**
 * pipeline-config.js — Read values from .claude/pipeline.config.json
 *
 * Library use (ESM):
 *
 *   import { getValue, loadConfig } from "./lib/pipeline-config.js";
 *   const threshold = getValue("tdd.coverageThreshold", 80);
 *
 * CLI use (from common.sh `common_config_get`):
 *
 *   node scripts/lib/pipeline-config.js get <dotted.path> [default]
 *
 * The config file is resolved relative to the repo root (the parent of
 * scripts/), or from NERVA_PIPELINE_CONFIG when set (tests use this). Exit
 * code is always 0 — the default is printed if anything fails, so callers can
 * rely on `VALUE=$(...)` under `set -e`.
 */
import { readFileSync, existsSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Repo root = scripts/lib/../.. */
export const REPO_ROOT = resolve(__dirname, "..", "..");
export const DEFAULT_CONFIG_PATH = join(REPO_ROOT, ".claude", "pipeline.config.json");

let cachedPath = null;
let cachedConfig = null;
let cachedMtimeMs = null;

function resolveConfigPath(configPath) {
  if (configPath) return resolve(configPath);
  if (process.env.NERVA_PIPELINE_CONFIG) return resolve(process.env.NERVA_PIPELINE_CONFIG);
  return DEFAULT_CONFIG_PATH;
}

/**
 * Load pipeline.config.json. Returns {} when the file is missing or invalid
 * so callers can rely on optional-chaining without crashing.
 */
export function loadConfig(configPath) {
  const path = resolveConfigPath(configPath);
  if (!existsSync(path)) return {};
  try {
    let mtime;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      mtime = null;
    }
    if (cachedConfig && cachedPath === path && cachedMtimeMs === mtime) return cachedConfig;
    cachedConfig = JSON.parse(readFileSync(path, "utf8"));
    cachedPath = path;
    cachedMtimeMs = mtime;
    return cachedConfig;
  } catch {
    return {};
  }
}

/**
 * Look up a dotted path. Missing keys → defaultValue. A `false` default is
 * honored exactly (returns false when the key is absent).
 */
export function getValue(dottedPath, defaultValue = undefined, configPath) {
  const config = loadConfig(configPath);
  const parts = String(dottedPath).split(".").filter(Boolean);
  let cur = config;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object" || !(p in cur)) {
      return defaultValue;
    }
    cur = cur[p];
  }
  return cur === undefined ? defaultValue : cur;
}

/** Render a value for shell consumption: booleans/numbers as text, objects as JSON. */
export function renderForShell(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function main(argv) {
  const [cmd, key, def] = argv;
  if (cmd !== "get" || !key) {
    console.error("Usage: node scripts/lib/pipeline-config.js get <dotted.path> [default]");
    process.stdout.write(def ?? "");
    return;
  }
  // Coerce shell-provided defaults so `false`/`0` survive the round trip.
  let defaultValue = def;
  if (def === "true") defaultValue = true;
  else if (def === "false") defaultValue = false;
  const value = getValue(key, defaultValue);
  process.stdout.write(renderForShell(value));
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  try {
    main(process.argv.slice(2));
  } catch {
    process.stdout.write(process.argv[4] ?? "");
  }
}
