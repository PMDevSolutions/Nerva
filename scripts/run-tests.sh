#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# run-tests.sh - Run Vitest tests with coverage
# Usage: ./scripts/run-tests.sh [--unit|--integration|--all|--coverage]
#
# Reads testing.integrationTimeout and tdd.coverageThreshold from
# .claude/pipeline.config.json; --coverage fails when line coverage is below
# the threshold.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
API_DIR="$(common_api_dir)"

TEST_MODE="all"
WITH_COVERAGE=false
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit)        TEST_MODE="unit"; shift ;;
    --integration) TEST_MODE="integration"; shift ;;
    --all)         TEST_MODE="all"; shift ;;
    --coverage)    WITH_COVERAGE=true; shift ;;
    --watch)       EXTRA_ARGS+=("--watch"); shift ;;
    --)            shift; EXTRA_ARGS+=("$@"); break ;;
    *)             EXTRA_ARGS+=("$1"); shift ;;
  esac
done

if [[ ! -d "$API_DIR" ]]; then
  error "API directory not found at: $API_DIR"
  exit 1
fi

cd "$API_DIR"

if [[ ! -d "node_modules" ]]; then
  error "Dependencies not installed. Run pnpm install first."
  exit 1
fi

VITEST_CMD=("npx" "vitest" "run")

case "$TEST_MODE" in
  unit)
    info "Running unit tests..."
    VITEST_CMD+=("--include" "tests/unit/**/*.{test,spec}.ts" "--include" "src/**/*.{test,spec}.ts")
    ;;
  integration)
    info "Running integration tests..."
    VITEST_CMD+=("--include" "tests/integration/**/*.{test,spec}.ts")
    VITEST_CMD+=("--testTimeout" "$(common_config_get 'testing.integrationTimeout' 30000)")
    ;;
  all)
    info "Running all tests..."
    ;;
esac

if [[ "$WITH_COVERAGE" == true ]]; then
  info "Coverage reporting enabled."
  VITEST_CMD+=("--coverage")
fi

if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  VITEST_CMD+=("${EXTRA_ARGS[@]}")
fi

echo -e "${CYAN}Command:${NC} ${VITEST_CMD[*]}"
echo ""

START_TIME=$(date +%s)

if "${VITEST_CMD[@]}"; then
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  echo ""
  success "Tests passed in ${DURATION}s."
else
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  echo ""
  error "Tests failed after ${DURATION}s."
  exit 1
fi

if [[ "$WITH_COVERAGE" == true && -f "coverage/coverage-summary.json" ]]; then
  echo ""
  info "Coverage report generated at: $API_DIR/coverage/"
  info "Open coverage/index.html for the full HTML report."

  # Enforce tdd.coverageThreshold from .claude/pipeline.config.json (default 80).
  # Uses the json-summary reporter output; templates/shared/vitest.config.ts emits it.
  THRESHOLD="$(common_config_get 'tdd.coverageThreshold' 80)"
  LINES_PCT="$(node -e '
    const s = JSON.parse(require("fs").readFileSync("coverage/coverage-summary.json", "utf8"));
    process.stdout.write(String(s.total?.lines?.pct ?? ""));
  ' 2>/dev/null || true)"
  if [[ -n "$LINES_PCT" ]]; then
    if node -e 'process.exit(Number(process.argv[1]) >= Number(process.argv[2]) ? 0 : 1)' "$LINES_PCT" "$THRESHOLD"; then
      success "Line coverage ${LINES_PCT}% meets the ${THRESHOLD}% threshold (tdd.coverageThreshold)."
    else
      error "Line coverage ${LINES_PCT}% is below the ${THRESHOLD}% threshold (tdd.coverageThreshold)."
      exit 1
    fi
  else
    warn "Could not read total line coverage from coverage-summary.json; threshold not enforced."
  fi
fi
