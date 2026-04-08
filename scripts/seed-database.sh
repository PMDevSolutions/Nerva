#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# seed-database.sh - Run database seed script
# Usage: ./scripts/seed-database.sh [--env development|staging|production]
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

TARGET_ENV="development"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      if [[ -z "${2:-}" ]]; then
        error "Missing value for --env."
        exit 1
      fi
      TARGET_ENV="$2"
      shift 2
      ;;
    *) error "Unknown option: $1"; exit 1 ;;
  esac
done

case "$TARGET_ENV" in
  development|staging|production) ;;
  *) error "Invalid environment: $TARGET_ENV. Must be development, staging, or production."; exit 1 ;;
esac

if [[ ! -d "$API_DIR" ]]; then
  error "API directory not found at: $API_DIR"
  exit 1
fi

cd "$API_DIR"

SEED_FILE="src/db/seed.ts"

if [[ ! -f "$SEED_FILE" ]]; then
  error "Seed file not found at: $API_DIR/$SEED_FILE"
  exit 1
fi

if [[ "$TARGET_ENV" == "production" ]]; then
  warn "You are about to seed the PRODUCTION database!"
  if [[ -t 0 ]]; then
    read -rp "$(echo -e "${RED}Type 'yes' to continue:${NC} ")" CONFIRM
    if [[ "$CONFIRM" != "yes" ]]; then
      info "Aborted."
      exit 0
    fi
  else
    error "Cannot seed production in non-interactive mode."
    exit 1
  fi
fi

ENV_FILE=".env.${TARGET_ENV}"
if [[ -f "$ENV_FILE" ]]; then
  info "Loading environment from: $ENV_FILE"
  set -a
  # shellcheck disable=SC1090 # Dynamic env file path determined at runtime
  source "$ENV_FILE"
  set +a
elif [[ -f ".env" ]]; then
  info "Loading environment from: .env"
  set -a
  # shellcheck disable=SC1090 # Dynamic env file path determined at runtime
  source ".env"
  set +a
else
  warn "No .env file found. Ensure DATABASE_URL is set."
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  error "DATABASE_URL is not set."
  exit 1
fi

MASKED_URL=$(echo "$DATABASE_URL" | sed -E 's#(://[^:]+:)[^@]+(@)#\1****\2#')
info "Environment: ${CYAN}$TARGET_ENV${NC}"
info "Database:    ${CYAN}$MASKED_URL${NC}"
echo ""

if ! npx tsx --version &>/dev/null 2>&1; then
  error "tsx is not available. Install with: pnpm add -D tsx"
  exit 1
fi

info "Running seed script..."
echo ""

START_TIME=$(date +%s)

if NODE_ENV="$TARGET_ENV" npx tsx "$SEED_FILE"; then
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  echo ""
  success "Database seeded in ${DURATION}s (env: $TARGET_ENV)."
else
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  echo ""
  error "Seed script failed after ${DURATION}s."
  exit 1
fi
