#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# generate-migration.sh - Generate a Drizzle ORM migration
# Usage: ./scripts/generate-migration.sh [migration-name] [--apply]
#
# After drizzle-kit generate succeeds, the new migrations are scanned for
# destructive DDL (scripts/check-destructive-migrations.js). When
# database.blockDestructiveMigrations is true in .claude/pipeline.config.json
# (the default), findings block the apply step; allowlist a reviewed
# migration with a header comment: -- nerva:allow-destructive: <reason>
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<EOF
Usage: $0 [migration-name] [--apply]

Generate a Drizzle ORM migration for the API project (api/ or \$NERVA_API_DIR).

Options:
  migration-name  Optional name passed to drizzle-kit generate --name
  --apply         Apply the migration immediately (skips the interactive prompt)
  --help, -h      Show this help

The generated SQL is scanned for destructive DDL before it can be applied.
Allowlist an intended destructive migration with a header comment line:
  -- nerva:allow-destructive: <reason>
EOF
}

MIGRATION_NAME=""
AUTO_APPLY=false

if [[ $# -gt 0 && "$1" != --* ]]; then
  MIGRATION_NAME="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)     AUTO_APPLY=true; shift ;;
    --help|-h)   usage; exit 0 ;;
    *)           error "Unknown option: $1"; usage >&2; exit 1 ;;
  esac
done

API_DIR="$(common_api_dir)"

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

# --- Destructive DDL guard ---------------------------------------------------

DESTRUCTIVE_CHECK="$SCRIPT_DIR/check-destructive-migrations.js"
if [[ -d "$MIGRATIONS_DIR" && -f "$DESTRUCTIVE_CHECK" ]] && have_cmd node; then
  step "Checking migrations for destructive DDL..."
  BLOCK_DESTRUCTIVE="$(common_config_get 'database.blockDestructiveMigrations' true)"
  CHECK_ARGS=("--dir" "$MIGRATIONS_DIR")
  if [[ "$BLOCK_DESTRUCTIVE" != "true" ]]; then
    CHECK_ARGS+=("--warn-only")
  fi

  set +e
  node "$DESTRUCTIVE_CHECK" "${CHECK_ARGS[@]}"
  CHECK_STATUS=$?
  set -e

  case "$CHECK_STATUS" in
    0)
      success "Destructive DDL check passed."
      ;;
    1)
      error "Destructive DDL found in migrations; the migration will NOT be applied."
      echo "" >&2
      echo "  If this destructive change is intended and has been reviewed, add a header" >&2
      echo "  comment line to the migration file and re-run:" >&2
      echo "" >&2
      echo "    -- nerva:allow-destructive: <why this destructive change is safe>" >&2
      echo "" >&2
      echo "  To report without blocking, set database.blockDestructiveMigrations to" >&2
      echo "  false in .claude/pipeline.config.json." >&2
      exit 1
      ;;
    *)
      warn "Destructive DDL check could not run (exit $CHECK_STATUS); continuing."
      ;;
  esac
  echo ""
else
  warn "Skipping destructive DDL check (node or $DESTRUCTIVE_CHECK not available)."
fi

# --- Apply --------------------------------------------------------------------

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
