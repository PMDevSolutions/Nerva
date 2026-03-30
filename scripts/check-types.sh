#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# check-types.sh - Run TypeScript type checking with tsc --noEmit
# Usage: ./scripts/check-types.sh [--strict] [--verbose]
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

VERBOSE=false
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verbose) VERBOSE=true; shift ;;
    --strict)  EXTRA_ARGS+=("--strict"); shift ;;
    *)         EXTRA_ARGS+=("$1"); shift ;;
  esac
done

if [[ ! -d "$API_DIR" ]]; then
  error "API directory not found at: $API_DIR"
  exit 1
fi

cd "$API_DIR"

if [[ ! -f "tsconfig.json" ]]; then
  error "tsconfig.json not found in $API_DIR"
  exit 1
fi

if [[ ! -d "node_modules" ]]; then
  error "Dependencies not installed. Run pnpm install first."
  exit 1
fi

info "Running TypeScript type check..."

TSC_CMD=("npx" "tsc" "--noEmit" "--pretty")

if [[ "$VERBOSE" == true ]]; then
  TSC_CMD+=("--listFiles")
fi

if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  TSC_CMD+=("${EXTRA_ARGS[@]}")
fi

echo -e "${CYAN}Command:${NC} ${TSC_CMD[*]}"
echo ""

START_TIME=$(date +%s)

if "${TSC_CMD[@]}"; then
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  echo ""
  success "Type check passed in ${DURATION}s. No type errors found."
else
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  echo ""
  error "Type check failed after ${DURATION}s. Fix the errors above."
  exit 1
fi
