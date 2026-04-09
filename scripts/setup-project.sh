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
  write_file "$API_DIR/src/index.ts" << 'SRCEOF'
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
  LOG_LEVEL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', logger());
app.use('*', cors());
app.use('*', secureHeaders());
app.use('*', requestId());

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    requestId: c.get('requestId'),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (c) => {
  return c.json({ message: 'Nerva API', version: '0.0.1' });
});

export default app;
SRCEOF
else
  write_file "$API_DIR/src/index.ts" << 'SRCEOF'
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { serve } from '@hono/node-server';

const app = new Hono();

app.use('*', logger());
app.use('*', cors());
app.use('*', secureHeaders());
app.use('*', requestId());

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    requestId: c.get('requestId'),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (c) => {
  return c.json({ message: 'Nerva API', version: '0.0.1' });
});

const port = Number(process.env.PORT) || 3000;
console.log(`Server starting on port ${port}`);

serve({ fetch: app.fetch, port });
SRCEOF
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

write_file "$API_DIR/src/db/schema.ts" << 'SEOF'
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
SEOF

write_file "$API_DIR/src/db/seed.ts" << 'SEEDEOF'
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

async function seed(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });
  console.log('Seeding database...');
  await db.insert(schema.users).values([
    { email: 'admin@example.com', name: 'Admin User' },
    { email: 'user@example.com', name: 'Test User' },
  ]);
  console.log('Database seeded successfully.');
  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
SEEDEOF

write_file "$API_DIR/tests/setup.ts" << 'TSEOF'
import { beforeAll, afterAll } from 'vitest';

beforeAll(() => {
  // Global setup before all tests
});

afterAll(() => {
  // Global cleanup after all tests
});
TSEOF

write_file "$API_DIR/tests/unit/health.test.ts" << 'HTEOF'
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';

describe('Health endpoint', () => {
  const app = new Hono();
  app.use('*', requestId());
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      requestId: c.get('requestId'),
    }),
  );

  it('should return ok status', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('should return a requestId', async () => {
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.requestId).toBeDefined();
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it('should include X-Request-Id response header', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('X-Request-Id')).not.toBeNull();
  });
});
HTEOF

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
