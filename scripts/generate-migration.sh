#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# generate-migration.sh - Generate a Drizzle ORM migration
# Usage: ./scripts/generate-migration.sh [migration-name]
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

MIGRATION_NAME="${1:-}"
AUTO_APPLY=false

shift 2>/dev/null || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) AUTO_APPLY=true; shift ;;
    *)       error "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ ! -d "$API_DIR" ]]; then
  error "API directory not found at: $API_DIR"
  exit 1
fi

cd "$API_DIR"

if [[ ! -f "drizzle.config.ts" ]]; then
  error "drizzle.config.ts not found. Ensure you are in a Nerva project."
  exit 1
fi

if [[ ! -d "node_modules" ]]; then
  error "Dependencies not installed. Run pnpm install first."
  exit 1
fi

GENERATE_CMD=("npx" "drizzle-kit" "generate")

if [[ -n "$MIGRATION_NAME" ]]; then
  GENERATE_CMD+=("--name" "$MIGRATION_NAME")
  info "Generating migration: ${CYAN}$MIGRATION_NAME${NC}"
else
  info "Generating migration (auto-named)..."
fi

echo -e "${CYAN}Command:${NC} ${GENERATE_CMD[*]}"
echo ""

if ! "${GENERATE_CMD[@]}"; then
  error "Migration generation failed."
  exit 1
fi

success "Migration generated successfully."
echo ""

MIGRATIONS_DIR="$API_DIR/src/db/migrations"
if [[ -d "$MIGRATIONS_DIR" ]]; then
  LATEST_SQL=$(find "$MIGRATIONS_DIR" -name "*.sql" -type f 2>/dev/null | sort | tail -n 1)
  if [[ -n "$LATEST_SQL" ]]; then
    info "Generated SQL:"
    echo ""
    echo -e "${CYAN}--- $(basename "$LATEST_SQL") ---${NC}"
    cat "$LATEST_SQL"
    echo -e "${CYAN}--- end ---${NC}"
    echo ""
  fi
fi

if [[ "$AUTO_APPLY" == true ]]; then
  info "Auto-apply enabled. Applying migration..."
elif [[ -t 0 ]]; then
  echo ""
  read -rp "$(echo -e "${YELLOW}Apply this migration now? [y/N]:${NC} ")" CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    info "Migration not applied. Run later with: cd api && npx drizzle-kit migrate"
    exit 0
  fi
else
  info "Non-interactive mode. Run manually: cd api && npx drizzle-kit migrate"
  exit 0
fi

info "Applying migration..."

if npx drizzle-kit migrate; then
  success "Migration applied successfully."
else
  error "Migration apply failed. Check your DATABASE_URL and try again."
  exit 1
fi
