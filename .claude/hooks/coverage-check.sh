#!/usr/bin/env bash
# coverage-check.sh — PostToolUse hook (matcher: Bash)
#
# After a vitest run whose output mentions coverage, prints a one-line
# reminder with the threshold from tdd.coverageThreshold in
# .claude/pipeline.config.json (default 80). When the text reporter's
# "All files" row is present, the statement percentage is compared to the
# threshold so the message says whether coverage is above or below it.
#
# Contract: JSON on stdin (see lib/hook-input.sh). Always exits 0. Stdout is
# surfaced to Claude as a reminder; no output means silent.

set -u
trap 'exit 0' ERR

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HOOK_DIR/../../scripts/lib/common.sh" ]]; then
  # shellcheck source=../../scripts/lib/common.sh
  source "$HOOK_DIR/../../scripts/lib/common.sh"
fi
# shellcheck source=lib/hook-input.sh
source "$HOOK_DIR/lib/hook-input.sh"

hook_skip_requested && exit 0
CMD="$(hook_tool_command)"
[[ -n "$CMD" ]] || exit 0
printf '%s' "$CMD" | grep -qE 'vitest|run-tests\.sh' || exit 0

OUT="$(hook_tool_output)"
[[ -n "$OUT" ]] || exit 0
printf '%s' "$OUT" | grep -qi 'coverage' || exit 0

NUM_RE='^[0-9]+(\.[0-9]+)?$'
THRESHOLD="$(common_config_get tdd.coverageThreshold 80)"
[[ "$THRESHOLD" =~ $NUM_RE ]] || THRESHOLD=80

# Statement % from the text reporter's "All files | 91.2 | ..." row, if present.
STMTS="$(printf '%s\n' "$OUT" | grep -E '^[[:space:]]*All files[[:space:]]*\|' | head -1 | awk -F'|' '{ gsub(/[[:space:]]/, "", $2); print $2 }')" || STMTS=""

if [[ "$STMTS" =~ $NUM_RE ]]; then
  if awk -v s="$STMTS" -v t="$THRESHOLD" 'BEGIN { exit !(s + 0 < t + 0) }'; then
    echo "[coverage-check] Statement coverage ${STMTS}% is BELOW the ${THRESHOLD}% threshold (tdd.coverageThreshold in .claude/pipeline.config.json). Add tests before moving on."
  else
    echo "[coverage-check] Statement coverage ${STMTS}% meets the ${THRESHOLD}% threshold (tdd.coverageThreshold). Check the branches, functions, and lines columns too."
  fi
else
  echo "[coverage-check] Coverage output detected. Confirm it meets the ${THRESHOLD}% threshold (tdd.coverageThreshold in .claude/pipeline.config.json)."
fi
exit 0
