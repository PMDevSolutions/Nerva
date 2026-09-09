#!/usr/bin/env bash
# quality-gate-reminder.sh — PostToolUse hook (matcher: Bash)
#
# When a vitest run reports that every test passed ("Tests  N passed" with no
# "failed"), remind to run the rest of the quality gate: type check, security
# scan, and the coverage threshold from tdd.coverageThreshold.
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
printf '%s' "$CMD" | grep -qE 'vitest|run-tests\.sh|(pnpm|npm|yarn|bun)([[:space:]]+run)?[[:space:]]+test' || exit 0

OUT="$(hook_tool_output)"
[[ -n "$OUT" ]] || exit 0
printf '%s' "$OUT" | grep -qE 'Tests[[:space:]]+[0-9]+ passed' || exit 0
if printf '%s' "$OUT" | grep -qi 'failed'; then
  exit 0
fi

NUM_RE='^[0-9]+(\.[0-9]+)?$'
THRESHOLD="$(common_config_get tdd.coverageThreshold 80)"
[[ "$THRESHOLD" =~ $NUM_RE ]] || THRESHOLD=80

echo "[quality-gate] All tests passed. Run the quality gate before calling this done: ./scripts/check-types.sh && ./scripts/security-scan.sh, then confirm coverage is at least ${THRESHOLD}% (pnpm vitest run --coverage; tdd.coverageThreshold in .claude/pipeline.config.json)."
exit 0
