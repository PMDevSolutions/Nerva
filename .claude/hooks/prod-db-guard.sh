#!/usr/bin/env bash
# prod-db-guard.sh — PreToolUse hook (matcher: Bash)
#
# Blocks Bash commands that would change a production database outside the
# migration workflow:
#   - `drizzle-kit push` (or `pnpm db:push`) when the same command references
#     production: --env production, PROD_DATABASE_URL, NODE_ENV=production,
#     or a database URL whose host/path contains "prod"
#   - psql / `pnpm db:*` / drizzle-kit invocations that reference production
#     AND contain DROP DATABASE, DROP SCHEMA, or TRUNCATE
#   - `drizzle-kit drop` (rewrites migration history) — always
#
# Everything else is allowed. A plain `drizzle-kit push` in dev passes; the
# PostToolUse migration-safety-reminder.sh nudges instead of blocking.
#
# Contract: JSON on stdin (see lib/hook-input.sh). Exit 2 blocks the tool call
# and the one-line stderr message is shown to Claude. Exit 0 allows it.
# Fails open on empty/malformed stdin or unexpected errors.

set -u
set -f
trap 'exit 0' ERR

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HOOK_DIR/../../scripts/lib/common.sh" ]]; then
  # shellcheck source=../../scripts/lib/common.sh
  source "$HOOK_DIR/../../scripts/lib/common.sh"
fi
# shellcheck source=lib/hook-input.sh
source "$HOOK_DIR/lib/hook-input.sh"
# shellcheck source=lib/bash-cmd.sh
source "$HOOK_DIR/lib/bash-cmd.sh"

hook_skip_requested && exit 0
[[ "$(hook_tool_name)" == "Bash" ]] || exit 0
CMD="$(hook_tool_command)"
[[ -n "$CMD" ]] || exit 0

# --- Does the command reference a production database? -----------------------

PROD_RE='--env[= ]+prod(uction)?|(PROD|PRODUCTION)_DATABASE_URL|DATABASE_URL_PROD(UCTION)?|NODE_ENV=production|(postgres(ql)?|pg|mysql)://[^[:space:]"]*prod[^[:space:]"]*'
PROD_REF="$(printf '%s' "$CMD" | grep -oE -- "$PROD_RE" 2>/dev/null | head -1)" || PROD_REF=""

DESTRUCTIVE_RE='DROP[[:space:]]+(DATABASE|SCHEMA)|(^|[^[:alnum:]_])TRUNCATE([^[:alnum:]_]|$)'

# --- Walk every simple command in the call -----------------------------------

BLOCK=""
hook_split_commands "$CMD"
for seg in ${HOOK_SEGMENTS[@]+"${HOOK_SEGMENTS[@]}"}; do
  [[ -n "${seg//[[:space:]]/}" ]] || continue
  hook_tokenize "$seg"
  hook_strip_wrappers
  argv=(${HOOK_ARGV[@]+"${HOOK_ARGV[@]}"})
  (( ${#argv[@]} >= 1 )) || continue

  # Identify the database tool in this segment and its subcommand.
  tool=""
  sub=""
  i=0
  while (( i < ${#argv[@]} )); do
    t="${argv[i]##*/}"
    case "$t" in
      drizzle-kit)
        tool="drizzle-kit"
        sub="${argv[i+1]:-}"
        break
        ;;
      psql|pgcli)
        tool="$t"
        break
        ;;
      db:*)
        tool="pnpm $t"
        sub="${t#db:}"
        break
        ;;
    esac
    i=$((i + 1))
  done
  [[ -n "$tool" ]] || continue

  case "$sub" in
    drop|drop:*)
      BLOCK="$tool $sub rewrites migration history (deletes a migration and edits the journal). Remove the migration file and its journal entry by hand, and never for a migration that has been applied"
      break
      ;;
    push|push:*)
      if [[ -n "$PROD_REF" ]]; then
        BLOCK="$tool push against a production target ($PROD_REF). push is dev-only; production changes go through drizzle-kit generate, review, then drizzle-kit migrate"
        break
      fi
      ;;
  esac

  if [[ -n "$PROD_REF" ]]; then
    hit="$(printf '%s' "$seg" | grep -oiE -- "$DESTRUCTIVE_RE" 2>/dev/null | head -1 | tr -s '[:space:]' ' ')" || hit=""
    if [[ -n "$hit" ]]; then
      hit="${hit#"${hit%%[![:space:]]*}"}"
      hit="${hit%"${hit##*[![:space:]]}"}"
      hit="$(printf '%s' "$hit" | tr -d '"();,')"
      BLOCK="destructive SQL ($hit) in a $tool command that references production ($PROD_REF). Put it in a reviewed migration instead"
      break
    fi
  fi
done

if [[ -n "$BLOCK" ]]; then
  echo "[prod-db-guard] Blocked: $BLOCK (bypass: run it yourself outside Claude Code, or launch Claude with NERVA_SKIP_HOOKS=1)." >&2
  exit 2
fi
exit 0
