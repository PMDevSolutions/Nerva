#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# check-types.sh - Run TypeScript type checking with tsc --noEmit
# Usage: ./scripts/check-types.sh [--strict] [--verbose]
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
API_DIR="$(common_api_dir)"

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

  # Advisory: qualityGate.noAnyTypes in .claude/pipeline.config.json.
  if [[ "$(common_config_get 'qualityGate.noAnyTypes' true)" == true && -d src ]]; then
    ANY_HITS=$(grep -rnE '(:\s*any\b|<any>|as any\b)' src --include='*.ts' 2>/dev/null | grep -v '\.test\.' | grep -v '\.spec\.' || true)
    if [[ -n "$ANY_HITS" ]]; then
      ANY_COUNT=$(printf '%s\n' "$ANY_HITS" | wc -l | tr -d ' ')
      warn "qualityGate.noAnyTypes is on and $ANY_COUNT use(s) of 'any' were found in src/:"
      printf '%s\n' "$ANY_HITS" | head -10 | sed 's/^/    /'
      [[ "$ANY_COUNT" -gt 10 ]] && echo "    ..."
    fi
  fi
else
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  echo ""
  error "Type check failed after ${DURATION}s. Fix the errors above."
  exit 1
fi
