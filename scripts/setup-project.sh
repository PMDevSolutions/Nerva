#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# setup-project.sh - Initialize a new Nerva API project
# Usage: ./scripts/setup-project.sh <project-name> [--cloudflare|--node] [--dry-run]
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
step()    { echo -e "${CYAN}[STEP]${NC} $*"; }
dryrun()  { echo -e "${YELLOW}[DRY RUN]${NC} $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATES_DIR="$PROJECT_ROOT/templates"

if [[ $# -lt 1 ]]; then
  error "Missing project name."
  echo "Usage: $0 <project-name> [--cloudflare|--node] [--dry-run]"
  echo "  --cloudflare   Set up for Cloudflare Workers deployment"
  echo "  --node         Set up for Node.js / Docker deployment (default)"
  echo "  --dry-run      Preview what would be created without making changes"
  exit 1
fi

PROJECT_NAME="$1"
shift

PLATFORM="node"
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cloudflare) PLATFORM="cloudflare"; shift ;;
    --node)       PLATFORM="node"; shift ;;
    --dry-run)    DRY_RUN=true; shift ;;
    *)            error "Unknown option: $1"; exit 1 ;;
  esac
done

TARGET_DIR="$(pwd)/$PROJECT_NAME"
API_DIR="$TARGET_DIR/api"

# --- Dry-run wrapper functions ---

make_dirs() {
  if $DRY_RUN; then
    for dir in "$@"; do dryrun "Would create: $dir"; done
  else
    mkdir -p "$@"
  fi
}

copy_file() {
  if $DRY_RUN; then
    dryrun "Would copy: $1 → $2"
  else
    cp "$1" "$2"
  fi
}

# Reads heredoc content from stdin; writes it or prints what would be generated.
write_file() {
  local dest="$1"
  if $DRY_RUN; then
    dryrun "Would generate: $dest"
    cat > /dev/null
  else
    cat > "$dest"
  fi
}

run_cmd() {
  if $DRY_RUN; then
    dryrun "Would run: $*"
  else
    "$@"
  fi
}

# --- Pre-flight checks ---

if ! $DRY_RUN && [[ -d "$TARGET_DIR" ]]; then
  error "Directory already exists: $TARGET_DIR"
  exit 1
fi

if ! command -v pnpm &>/dev/null; then
  if $DRY_RUN; then
    warn "pnpm is not installed. Install: corepack enable && corepack prepare pnpm@latest --activate"
  else
    error "pnpm is not installed. Install: corepack enable && corepack prepare pnpm@latest --activate"
    exit 1
  fi
fi

if $DRY_RUN; then
  echo ""
  info "Dry-run preview for project: ${CYAN}$PROJECT_NAME${NC} (platform: $PLATFORM)"
  echo ""
fi

info "Creating Nerva project: ${CYAN}$PROJECT_NAME${NC} (platform: $PLATFORM)"

step "Creating directory structure..."
make_dirs "$TARGET_DIR/api/src"/{routes,db/migrations,middleware,lib,types}
make_dirs "$TARGET_DIR/api/tests"/{unit,integration,load}
make_dirs "$TARGET_DIR/docs"
success "Directory structure created."

step "Copying shared configuration templates..."
copy_file "$TEMPLATES_DIR/shared/tsconfig.json"      "$API_DIR/tsconfig.json"
copy_file "$TEMPLATES_DIR/shared/eslint.config.js"   "$API_DIR/eslint.config.js"
copy_file "$TEMPLATES_DIR/shared/prettier.config.js" "$API_DIR/prettier.config.js"
copy_file "$TEMPLATES_DIR/shared/vitest.config.ts"   "$API_DIR/vitest.config.ts"
success "Shared templates copied."

step "Initializing package.json..."
if ! $DRY_RUN; then
  cd "$API_DIR"
fi

write_file "$API_DIR/package.json" << PKGJSON
{
  "name": "$PROJECT_NAME",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio",
    "db:seed": "tsx src/db/seed.ts"
  }
}
PKGJSON

success "package.json created."

step "Installing production dependencies..."
run_cmd pnpm add hono drizzle-orm postgres zod @hono/zod-validator
success "Production dependencies installed."

step "Installing dev dependencies..."
run_cmd pnpm add -D vitest typescript eslint prettier drizzle-kit @types/node tsx \
  @eslint/js typescript-eslint @vitest/coverage-v8
success "Dev dependencies installed."

step "Creating initial source files..."

if [[ "$PLATFORM" == "cloudflare" ]]; then
  copy_file "$TEMPLATES_DIR/snippets/cloudflare/src/index.ts" "$API_DIR/src/index.ts"
else
  copy_file "$TEMPLATES_DIR/snippets/node/src/index.ts" "$API_DIR/src/index.ts"
  run_cmd pnpm add @hono/node-server
fi

write_file "$API_DIR/drizzle.config.ts" << 'DEOF'
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
DEOF

copy_file "$TEMPLATES_DIR/snippets/shared/src/db/schema.ts" "$API_DIR/src/db/schema.ts"
copy_file "$TEMPLATES_DIR/snippets/shared/src/db/client.ts" "$API_DIR/src/db/client.ts"
copy_file "$TEMPLATES_DIR/snippets/shared/src/db/seed.ts" "$API_DIR/src/db/seed.ts"

if [[ "$PLATFORM" == "cloudflare" ]]; then
  copy_file "$TEMPLATES_DIR/snippets/cloudflare/src/db/ping.ts" "$API_DIR/src/db/ping.ts"
  copy_file "$TEMPLATES_DIR/snippets/cloudflare/src/routes/health.ts" "$API_DIR/src/routes/health.ts"
else
  copy_file "$TEMPLATES_DIR/snippets/node/src/db/ping.ts" "$API_DIR/src/db/ping.ts"
  copy_file "$TEMPLATES_DIR/snippets/node/src/routes/health.ts" "$API_DIR/src/routes/health.ts"
fi

copy_file "$TEMPLATES_DIR/snippets/shared/tests/setup.ts" "$API_DIR/tests/setup.ts"

if [[ "$PLATFORM" == "cloudflare" ]]; then
  copy_file "$TEMPLATES_DIR/snippets/cloudflare/tests/unit/health.test.ts" "$API_DIR/tests/unit/health.test.ts"
else
  copy_file "$TEMPLATES_DIR/snippets/node/tests/unit/health.test.ts" "$API_DIR/tests/unit/health.test.ts"
fi

success "Initial source files created."


# ---- Platform-specific setup ----
if [[ "$PLATFORM" == "cloudflare" ]]; then
  step "Setting up Cloudflare Workers..."
  run_cmd pnpm add -D wrangler
  copy_file "$TEMPLATES_DIR/cloudflare-workers/wrangler.toml" "$API_DIR/wrangler.toml"

  write_file "$API_DIR/.dev.vars.example" << 'DVEOF'
# .dev.vars — Cloudflare Workers local environment variables
# This is the Workers equivalent of .env for local development.
# Copy this file to .dev.vars and fill in your values:
#   cp .dev.vars.example .dev.vars

ENVIRONMENT=development
LOG_LEVEL=debug
DATABASE_URL=postgresql://nerva:nerva_secret@localhost:5432/nerva_db
APP_VERSION=0.0.1
HEALTH_DB_TIMEOUT_MS=2000
DVEOF

  success "Cloudflare Workers configured. Edit wrangler.toml with your resource IDs."
else
  step "Setting up Node.js / Docker..."
  copy_file "$TEMPLATES_DIR/node-server/Dockerfile" "$API_DIR/Dockerfile"
  copy_file "$TEMPLATES_DIR/node-server/docker-compose.yml" "$API_DIR/docker-compose.yml"

  write_file "$API_DIR/.env.example" << 'ENVEOF'
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://nerva:nerva_secret@localhost:5432/nerva_db
LOG_LEVEL=debug
APP_VERSION=0.0.1
HEALTH_DB_TIMEOUT_MS=2000
ENVEOF

  success "Node.js / Docker configured."
fi

# ---- .gitignore ----
write_file "$API_DIR/.gitignore" << 'GEOF'
node_modules/
dist/
.env
.env.local
.env.*.local
*.log
.wrangler/
.dev.vars
coverage/
.DS_Store
GEOF

# ---- Summary ----
echo ""
echo -e "${GREEN}============================================${NC}"
if $DRY_RUN; then
  echo -e "${GREEN} Dry-run complete — no files were created${NC}"
else
  echo -e "${GREEN} Project created successfully!${NC}"
fi
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  Name:      ${CYAN}$PROJECT_NAME${NC}"
echo -e "  Platform:  ${CYAN}$PLATFORM${NC}"
echo -e "  Location:  ${CYAN}$API_DIR${NC}"
echo ""
if ! $DRY_RUN; then
  echo "  Next steps:"
  echo "    cd $PROJECT_NAME/api"
  if [[ "$PLATFORM" == "cloudflare" ]]; then
    echo "    npx wrangler dev          # Start local dev server"
  else
    echo "    docker compose up -d      # Start PostgreSQL"
    echo "    pnpm dev                  # Start dev server"
  fi
  echo "    pnpm test                 # Run tests"
  echo ""
fi
