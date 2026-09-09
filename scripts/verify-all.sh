#!/usr/bin/env bash
# verify-all.sh — Run every local quality check in sequence and report a summary.
#
# Backs both /verify-all (interactive) and /ci (machine-readable, non-interactive)
# slash commands. Each check is treated as opaque: we capture its exit code and
# the last lines of its output for the report. Checks whose backing script or
# subject (api/ directory, migrations, package.json) is absent are skipped with
# a reason rather than failed, so the orchestrator is safe to run on a bare
# framework checkout as well as on a generated API project.
#
# Usage:
#   ./scripts/verify-all.sh                   # Human-readable summary
#   ./scripts/verify-all.sh --json            # Machine-readable JSON summary
#   ./scripts/verify-all.sh --ci              # Implies --json + non-interactive
#   ./scripts/verify-all.sh --skip <a,b,c>    # Skip named checks
#   ./scripts/verify-all.sh --include <a,b>   # Run only the named checks
#   ./scripts/verify-all.sh --list            # Print check names and exit
#   ./scripts/verify-all.sh --root <dir>      # Check a different project tree
#   ./scripts/verify-all.sh --help            # This text
#
# Check names (in run order):
#   shell-syntax, js-syntax, json, pipeline-config, doc-counts, script-tests,
#   types, tests, security, destructive-migrations
#
# Exit codes:
#   0 — every check passed (or was skipped)
#   1 — one or more checks failed
#   2 — usage error (unknown flag or check name)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

TAIL_LINES=15

JSON_OUTPUT=false
CI_MODE=false
SKIP_LIST=""
INCLUDE_LIST=""
LIST_ONLY=false
ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_OUTPUT=true ;;
    --ci) CI_MODE=true; JSON_OUTPUT=true ;;
    --skip)
      [[ -n "${2:-}" ]] || { say_err "--skip requires a comma-separated list"; exit 2; }
      SKIP_LIST="$2"; shift ;;
    --include)
      [[ -n "${2:-}" ]] || { say_err "--include requires a comma-separated list"; exit 2; }
      INCLUDE_LIST="$2"; shift ;;
    --root)
      [[ -n "${2:-}" ]] || { say_err "--root requires a directory argument"; exit 2; }
      ROOT="$2"; shift ;;
    --list) LIST_ONLY=true ;;
    -h|--help)
      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      say_err "Unknown argument: $1 (try --help)"
      exit 2
      ;;
  esac
  shift
done

# Each check: name | kind | target
#   kind = fn    → a bash function defined below (target = function name)
#   kind = bash  → a shell script under <root>/ run with bash
#   kind = node  → a JS script under <root>/ run with node
#   kind = pnpm  → a package.json script run with `pnpm <target>`
ALL_CHECKS=(
  "shell-syntax|fn|check_shell_syntax"
  "js-syntax|fn|check_js_syntax"
  "json|fn|check_json"
  "pipeline-config|node|scripts/validate-pipeline-config.js"
  "doc-counts|bash|scripts/check-doc-counts.sh"
  "script-tests|pnpm|test"
  "types|bash|scripts/check-types.sh"
  "tests|bash|scripts/run-tests.sh"
  "security|bash|scripts/security-scan.sh"
  "destructive-migrations|node|scripts/check-destructive-migrations.js"
)

check_names() {
  local entry
  for entry in "${ALL_CHECKS[@]}"; do
    echo "${entry%%|*}"
  done
}

if [[ "$LIST_ONLY" == "true" ]]; then
  check_names
  exit 0
fi

# --- Validate --skip / --include names -----------------------------------
is_known_check() {
  local name="$1" entry
  for entry in "${ALL_CHECKS[@]}"; do
    [[ "${entry%%|*}" == "$name" ]] && return 0
  done
  return 1
}

validate_csv() {
  local flag="$1" csv="$2" part
  [[ -z "$csv" ]] && return 0
  local old_ifs="$IFS"
  IFS=','
  for part in $csv; do
    part="$(echo "$part" | tr -d ' ')"
    [[ -z "$part" ]] && continue
    if ! is_known_check "$part"; then
      IFS="$old_ifs"
      say_err "Unknown check name for $flag: $part"
      echo "Valid names: $(check_names | tr '\n' ' ')" >&2
      exit 2
    fi
  done
  IFS="$old_ifs"
}
validate_csv "--skip" "$SKIP_LIST"
validate_csv "--include" "$INCLUDE_LIST"

# --- Resolve project root and API dir ------------------------------------
if [[ -z "$ROOT" ]]; then
  ROOT="$(common_project_root)"
fi
if [[ ! -d "$ROOT" ]]; then
  say_err "Not a directory: $ROOT"
  exit 2
fi
ROOT="$(cd "$ROOT" && pwd)"
cd "$ROOT" || exit 2
API_DIR="${NERVA_API_DIR:-$ROOT/api}"
MIGRATIONS_DIR="$API_DIR/src/db/migrations"

# Recursion guard: `script-tests` runs `pnpm test`, whose suite exercises this
# very script. The nested run must not start another `pnpm test`.
NESTED_RUN=false
if [[ -n "${NERVA_VERIFY_ALL_ACTIVE:-}" ]]; then
  NESTED_RUN=true
fi
export NERVA_VERIFY_ALL_ACTIVE=1

# Children never get a TTY, so colour is already off for colors.sh-aware
# scripts; NO_COLOR also silences the older scripts that hardcode escapes.
export NO_COLOR=1
if $CI_MODE; then
  export CI=1
fi

# --- Filtering ---
should_run() {
  local name="$1"
  if [[ -n "$INCLUDE_LIST" ]]; then
    common_csv_contains "$INCLUDE_LIST" "$name" && return 0
    return 1
  fi
  if [[ -n "$SKIP_LIST" ]]; then
    common_csv_contains "$SKIP_LIST" "$name" && return 1
  fi
  return 0
}

# --- Inline checks -------------------------------------------------------
# Each prints its findings and returns the exit code. File lists are computed
# by list_* helpers so the pre-check can skip when there is nothing to do.

list_shell_files() {
  local f
  for f in scripts/*.sh scripts/lib/*.sh .claude/hooks/*.sh; do
    [[ -f "$f" ]] && echo "$f"
  done
  return 0
}

list_js_files() {
  local f
  for f in scripts/*.js scripts/lib/*.js; do
    [[ -f "$f" ]] && echo "$f"
  done
  return 0
}

list_json_files() {
  local f
  for f in .claude/pipeline.config.json .claude/settings.json package.json; do
    [[ -f "$f" ]] && echo "$f"
  done
  return 0
}

check_shell_syntax() {
  local f rc=0 n=0
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    n=$((n + 1))
    if bash -n "$f" 2>&1; then
      say_pass "$f"
    else
      say_fail "$f"
      rc=1
    fi
  done < <(list_shell_files)
  echo "Checked $n shell script(s)"
  return $rc
}

check_js_syntax() {
  local f rc=0 n=0
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    n=$((n + 1))
    if node --check "$f" 2>&1; then
      say_pass "$f"
    else
      say_fail "$f"
      rc=1
    fi
  done < <(list_js_files)
  echo "Checked $n JavaScript file(s)"
  return $rc
}

check_json() {
  local f rc=0 n=0
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    n=$((n + 1))
    if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" 2>&1; then
      say_pass "$f"
    else
      say_fail "$f"
      rc=1
    fi
  done < <(list_json_files)
  echo "Checked $n JSON file(s)"
  return $rc
}

# --- Conditional pre-checks ----------------------------------------------
# Prints a skip reason and returns 0 when the check should be skipped;
# prints nothing and returns 1 when it should run.
skip_reason() {
  local name="$1" kind="$2" target="$3"
  case "$name" in
    shell-syntax)
      [[ -z "$(list_shell_files)" ]] && { echo "no shell scripts found"; return 0; }
      ;;
    js-syntax)
      have_cmd node || { echo "node not found"; return 0; }
      [[ -z "$(list_js_files)" ]] && { echo "no JavaScript files under scripts/"; return 0; }
      ;;
    json)
      have_cmd node || { echo "node not found"; return 0; }
      [[ -z "$(list_json_files)" ]] && { echo "no JSON config files found"; return 0; }
      ;;
    script-tests)
      $NESTED_RUN && { echo "nested verify-all run (recursion guard)"; return 0; }
      have_cmd pnpm || { echo "pnpm not found"; return 0; }
      [[ -f package.json ]] || { echo "no package.json"; return 0; }
      if have_cmd node && ! node -e 'const p=JSON.parse(require("fs").readFileSync("package.json","utf8")); process.exit(p.scripts && p.scripts.test ? 0 : 1)' 2>/dev/null; then
        echo "no \"test\" script in package.json"; return 0
      fi
      ;;
    types|tests|security)
      [[ -d "$API_DIR" ]] || { echo "no api/ directory"; return 0; }
      ;;
    destructive-migrations)
      [[ -d "$MIGRATIONS_DIR" ]] || { echo "no migrations directory at ${MIGRATIONS_DIR#$ROOT/}"; return 0; }
      ;;
  esac
  case "$kind" in
    bash|node)
      [[ -f "$target" ]] || { echo "script not found: $target"; return 0; }
      [[ "$kind" == "node" ]] && ! have_cmd node && { echo "node not found"; return 0; }
      ;;
  esac
  return 1
}

# --- Runner ---
RESULTS_NAME=()
RESULTS_STATUS=()
RESULTS_EXIT=()
RESULTS_MS=()
RESULTS_REASON=()
RESULTS_OUTPUT=()
RESULTS_CMD=()

emit_progress() {
  $JSON_OUTPUT && return 0
  echo "$@"
}

record() {
  RESULTS_NAME+=("$1")
  RESULTS_STATUS+=("$2")
  RESULTS_EXIT+=("$3")
  RESULTS_MS+=("$4")
  RESULTS_REASON+=("$5")
  RESULTS_OUTPUT+=("$6")
  RESULTS_CMD+=("$7")
}

ESC="$(printf '\033')"
strip_ansi() {
  sed -e "s/${ESC}\[[0-9;]*[A-Za-z]//g" | tr -d '\000-\010\013\014\016-\037'
}

OUT_FILE="$(mktemp)"
common_track_tmpfile "$OUT_FILE"

run_check() {
  local name="$1" kind="$2" target="$3"
  local cmd reason

  if ! should_run "$name"; then
    record "$name" "skip" 0 0 "filtered by --skip/--include" "" ""
    return 0
  fi

  if reason="$(skip_reason "$name" "$kind" "$target")"; then
    record "$name" "skip" 0 0 "$reason" "" ""
    emit_progress "▸ $name … skipped ($reason)"
    return 0
  fi

  case "$kind" in
    fn)   cmd="$target" ;;
    bash) cmd="bash $target" ;;
    node) cmd="node $target" ;;
    pnpm) cmd="pnpm $target" ;;
  esac

  emit_progress "▸ $name …"
  local start end duration_ms exit_code=0
  start="$(common_now_ms)"
  : > "$OUT_FILE"
  case "$kind" in
    fn)   "$target" > "$OUT_FILE" 2>&1 < /dev/null || exit_code=$? ;;
    bash) bash "$target" > "$OUT_FILE" 2>&1 < /dev/null || exit_code=$? ;;
    node) node "$target" > "$OUT_FILE" 2>&1 < /dev/null || exit_code=$? ;;
    pnpm) pnpm "$target" > "$OUT_FILE" 2>&1 < /dev/null || exit_code=$? ;;
  esac
  end="$(common_now_ms)"
  duration_ms=$((end - start))

  if [[ "$exit_code" -eq 0 ]]; then
    record "$name" "pass" 0 "$duration_ms" "" "" "$cmd"
    emit_progress "  ✓ pass (${duration_ms}ms)"
  else
    local tail_text
    tail_text="$(tail -n "$TAIL_LINES" "$OUT_FILE" | strip_ansi)"
    record "$name" "fail" "$exit_code" "$duration_ms" "exit $exit_code" "$tail_text" "$cmd"
    emit_progress "  ✗ fail (exit $exit_code, ${duration_ms}ms)"
    if ! $JSON_OUTPUT && [[ -n "$tail_text" ]]; then
      echo "    --- last ${TAIL_LINES} lines of output ---"
      printf '%s\n' "$tail_text" | sed 's/^/    | /'
      echo "    ---"
    fi
  fi
}

# --- Run all ---
$JSON_OUTPUT || say_banner "verify-all"
$JSON_OUTPUT || echo ""

for entry in "${ALL_CHECKS[@]}"; do
  name="${entry%%|*}"
  rest="${entry#*|}"
  kind="${rest%%|*}"
  target="${rest#*|}"
  run_check "$name" "$kind" "$target"
done

# --- Summary ---
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
for status in "${RESULTS_STATUS[@]}"; do
  case "$status" in
    pass) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    fail) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    skip) SKIP_COUNT=$((SKIP_COUNT + 1)) ;;
  esac
done
TOTAL=${#RESULTS_NAME[@]}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  printf '%s' "$s"
}

if $JSON_OUTPUT; then
  overall="pass"
  [[ "$FAIL_COUNT" -gt 0 ]] && overall="fail"
  printf '{\n'
  printf '  "status": "%s",\n' "$overall"
  printf '  "checks": [\n'
  i=0
  while [[ $i -lt $TOTAL ]]; do
    printf '    { "name": "%s", "status": "%s", "exitCode": %d, "durationMs": %d' \
      "${RESULTS_NAME[$i]}" "${RESULTS_STATUS[$i]}" "${RESULTS_EXIT[$i]}" "${RESULTS_MS[$i]}"
    if [[ -n "${RESULTS_REASON[$i]}" ]]; then
      printf ', "reason": "%s"' "$(json_escape "${RESULTS_REASON[$i]}")"
    fi
    if [[ "${RESULTS_STATUS[$i]}" == "fail" ]]; then
      printf ', "command": "%s"' "$(json_escape "${RESULTS_CMD[$i]}")"
      printf ', "output": "%s"' "$(json_escape "${RESULTS_OUTPUT[$i]}")"
    fi
    printf ' }'
    i=$((i + 1))
    [[ $i -lt $TOTAL ]] && printf ','
    printf '\n'
  done
  printf '  ],\n'
  printf '  "summary": { "passed": %d, "failed": %d, "skipped": %d, "total": %d }\n' \
    "$PASS_COUNT" "$FAIL_COUNT" "$SKIP_COUNT" "$TOTAL"
  printf '}\n'
else
  echo ""
  say_banner "Summary"
  printf '%-24s %-6s %-10s %s\n' "Check" "Status" "Duration" "Reason"
  printf '%-24s %-6s %-10s %s\n' "-----" "------" "--------" "------"
  i=0
  while [[ $i -lt $TOTAL ]]; do
    printf '%-24s %-6s %-10s %s\n' \
      "${RESULTS_NAME[$i]}" "${RESULTS_STATUS[$i]}" "${RESULTS_MS[$i]}ms" "${RESULTS_REASON[$i]}"
    i=$((i + 1))
  done
  echo ""
  echo "Totals: ${PASS_COUNT} passed, ${FAIL_COUNT} failed, ${SKIP_COUNT} skipped"
  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    echo ""
    echo "✗ Some checks failed. Re-run each failing check individually for full output:"
    i=0
    while [[ $i -lt $TOTAL ]]; do
      if [[ "${RESULTS_STATUS[$i]}" == "fail" ]]; then
        if [[ "${RESULTS_CMD[$i]}" == check_* ]]; then
          echo "  ./scripts/verify-all.sh --include ${RESULTS_NAME[$i]}"
        else
          echo "  ${RESULTS_CMD[$i]}"
        fi
      fi
      i=$((i + 1))
    done
  else
    echo ""
    echo "✓ All checks passed."
  fi
fi

# --- Exit code ---
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
exit 0
