#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# run-tests.sh - Run Vitest tests with coverage
# Usage: ./scripts/run-tests.sh [--unit|--integration|--all|--coverage]
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$PROJECT_ROOT/api"

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
    VITEST_CMD+=("--testTimeout" "30000")
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
fi
