#!/usr/bin/env bash
# hook-input.sh — stdin helpers for .claude/hooks/*.sh
#
# Claude Code passes ONE JSON object on stdin to every hook, for example:
#
#   {
#     "hook_event_name": "PreToolUse",
#     "tool_name": "Bash",
#     "tool_input": { "command": "git add .env" },
#     "tool_response": { "stdout": "...", "stderr": "..." },   // PostToolUse only
#     "cwd": "/path/to/project"
#   }
#
# Source this once near the top of a hook (after scripts/lib/common.sh when
# that file is available):
#
#   HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$HOOK_DIR/lib/hook-input.sh"
#
# It reads stdin exactly once into HOOK_INPUT and provides:
#
#   hook_get <path>       jq-style path such as `.tool_input.command`. Prints ""
#                         (and returns 0) when the key is missing, the value is
#                         null/false, or stdin was not JSON. Uses jq when it is
#                         on PATH, otherwise node (always present in Nerva).
#                         Object/array values are printed as JSON text.
#   hook_tool_name        `hook_get .tool_name`
#   hook_tool_command     `hook_get .tool_input.command`
#   hook_tool_output      tool_response as plain text. The Bash tool returns an
#                         object ({stdout, stderr, ...}); other tools may return
#                         a string or an {output}/{content} object. All shapes
#                         come back as text (stdout then stderr for Bash).
#   (set NERVA_HOOK_JSON_TOOL=node to force the node path; tests use this)
#   hook_skip_requested   returns 0 when NERVA_SKIP_HOOKS=1 (or "true") is set
#                         in the environment Claude Code was launched from. This
#                         is the user-level bypass: Claude's own Bash commands
#                         cannot influence the hook process environment.
#
# Fallbacks: when scripts/lib/common.sh was not sourced (for instance because
# the hooks were copied into a generated project), minimal `have_cmd` and
# `common_config_get` are defined here so hooks keep working.
#
# Nothing in this file exits the caller and every helper returns 0.

if [[ -n "${__NERVA_HOOK_INPUT_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
__NERVA_HOOK_INPUT_LOADED=1

if ! declare -F have_cmd >/dev/null 2>&1; then
  have_cmd() { command -v "$1" >/dev/null 2>&1; }
fi

if ! declare -F common_config_get >/dev/null 2>&1; then
  # Fallback reader for .claude/pipeline.config.json (cwd-relative, or the file
  # named by NERVA_PIPELINE_CONFIG). Mirrors scripts/lib/common.sh's contract:
  # prints the default when anything is missing.
  common_config_get() {
    local key="${1:-}"
    local default="${2-}"
    local file="${NERVA_PIPELINE_CONFIG:-.claude/pipeline.config.json}"
    local out=""
    if [[ -z "$key" || ! -f "$file" ]] || ! have_cmd node; then
      echo "$default"
      return 0
    fi
    out="$(HOOK_CFG_FILE="$file" HOOK_CFG_KEY="$key" node -e '
      const fs = require("fs");
      let v;
      try { v = JSON.parse(fs.readFileSync(process.env.HOOK_CFG_FILE, "utf8")); } catch { process.exit(1); }
      for (const p of process.env.HOOK_CFG_KEY.split(".").filter(Boolean)) {
        if (v === null || typeof v !== "object" || !(p in v)) process.exit(1);
        v = v[p];
      }
      if (v === undefined || v === null) process.exit(1);
      process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
    ' 2>/dev/null)" || out=""
    if [[ -n "$out" ]]; then
      echo "$out"
    else
      echo "$default"
    fi
    return 0
  }
fi

# --- Read stdin once -------------------------------------------------------

HOOK_INPUT=""
# Skip the read when stdin is a terminal (someone ran the hook by hand with
# no pipe) so the script does not hang waiting for input.
if [[ ! -t 0 ]]; then
  HOOK_INPUT="$(cat 2>/dev/null || true)"
fi

# --- Accessors -------------------------------------------------------------

hook_get() {
  local path="${1:-}"
  if [[ -z "$HOOK_INPUT" || -z "$path" ]]; then
    return 0
  fi
  [[ "$path" == .* ]] || path=".$path"

  # NERVA_HOOK_JSON_TOOL=node forces the node path (used by the test-suite).
  if [[ "${NERVA_HOOK_JSON_TOOL:-}" != "node" ]] && have_cmd jq; then
    printf '%s' "$HOOK_INPUT" | jq -r "$path // empty" 2>/dev/null || true
  elif have_cmd node; then
    # Dotted object keys only (".a.b.c"); that is all the hooks need.
    printf '%s' "$HOOK_INPUT" | HOOK_PATH="$path" node -e '
      const fs = require("fs");
      let v;
      try { v = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(0); }
      for (const p of process.env.HOOK_PATH.split(".").filter(Boolean)) {
        if (v === null || typeof v !== "object" || !(p in v)) process.exit(0);
        v = v[p];
      }
      if (v === undefined || v === null || v === false) process.exit(0);
      process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
    ' 2>/dev/null || true
  fi
  return 0
}

hook_tool_name() {
  hook_get .tool_name
}

hook_tool_command() {
  hook_get .tool_input.command
}

hook_tool_output() {
  local raw out err
  raw="$(hook_get .tool_response)"
  if [[ -z "$raw" ]]; then
    return 0
  fi
  case "$raw" in
    \{*)
      out="$(hook_get .tool_response.stdout)"
      err="$(hook_get .tool_response.stderr)"
      if [[ -n "$out" || -n "$err" ]]; then
        printf '%s' "$out"
        if [[ -n "$out" && -n "$err" ]]; then
          printf '\n'
        fi
        printf '%s' "$err"
        return 0
      fi
      out="$(hook_get .tool_response.output)"
      if [[ -n "$out" ]]; then
        printf '%s' "$out"
        return 0
      fi
      out="$(hook_get .tool_response.content)"
      if [[ -n "$out" ]]; then
        printf '%s' "$out"
        return 0
      fi
      printf '%s' "$raw"
      ;;
    *)
      printf '%s' "$raw"
      ;;
  esac
  return 0
}

hook_skip_requested() {
  [[ "${NERVA_SKIP_HOOKS:-}" == "1" || "${NERVA_SKIP_HOOKS:-}" == "true" ]]
}
