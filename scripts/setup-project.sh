#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# setup-project.sh - Initialize a new Nerva API project
# Usage: ./scripts/setup-project.sh <project-name> [--cloudflare|--node]
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$PROJECT_ROOT/api"
TEMPLATES_DIR="$PROJECT_ROOT/templates"

if [[ $# -lt 1 ]]; then
  error "Missing project name."
  echo "Usage: $0 <project-name> [--cloudflare|--node]"
  echo "  --cloudflare   Set up for Cloudflare Workers deployment"
  echo "  --node         Set up for Node.js / Docker deployment (default)"
  exit 1
fi

PROJECT_NAME="$1"
shift

PLATFORM="node"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cloudflare) PLATFORM="cloudflare"; shift ;;
    --node)       PLATFORM="node"; shift ;;
    *)            error "Unknown option: $1"; exit 1 ;;
  esac
done

TARGET_DIR="$(pwd)/$PROJECT_NAME"

if [[ -d "$TARGET_DIR" ]]; then
  error "Directory already exists: $TARGET_DIR"
  exit 1
fi

if ! command -v pnpm &>/dev/null; then
  error "pnpm is not installed. Install: corepack enable && corepack prepare pnpm@latest --activate"
  exit 1
fi

info "Creating Nerva project: ${CYAN}$PROJECT_NAME${NC} (platform: $PLATFORM)"

step "Creating directory structure..."
mkdir -p "$TARGET_DIR/api/src"/{routes,db/migrations,middleware,lib,types}
mkdir -p "$TARGET_DIR/api/tests"/{unit,integration,load}
mkdir -p "$TARGET_DIR/docs"
success "Directory structure created."

step "Copying shared configuration templates..."
cp "$TEMPLATES_DIR/shared/tsconfig.json"      "$TARGET_DIR/api/tsconfig.json"
cp "$TEMPLATES_DIR/shared/eslint.config.js"   "$TARGET_DIR/api/eslint.config.js"
cp "$TEMPLATES_DIR/shared/prettier.config.js" "$TARGET_DIR/api/prettier.config.js"
cp "$TEMPLATES_DIR/shared/vitest.config.ts"   "$TARGET_DIR/api/vitest.config.ts"
success "Shared templates copied."

step "Initializing package.json..."
cd "$TARGET_DIR/api"

cat > package.json << PKGJSON
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
pnpm add hono drizzle-orm postgres zod @hono/zod-validator
success "Production dependencies installed."

step "Installing dev dependencies..."
pnpm add -D vitest typescript eslint prettier drizzle-kit @types/node tsx \
  @eslint/js typescript-eslint @vitest/coverage-v8
success "Dev dependencies installed."

step "Creating initial source files..."

if [[ "$PLATFORM" == "cloudflare" ]]; then
  cat > src/index.ts << 'SRCEOF'
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
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

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (c) => {
  return c.json({ message: 'Nerva API', version: '0.0.1' });
});

export default app;
SRCEOF
else
  cat > src/index.ts << 'SRCEOF'
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { serve } from '@hono/node-server';

const app = new Hono();

app.use('*', logger());
app.use('*', cors());
app.use('*', secureHeaders());

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (c) => {
  return c.json({ message: 'Nerva API', version: '0.0.1' });
});

const port = Number(process.env.PORT) || 3000;
console.log(`Server starting on port ${port}`);

serve({ fetch: app.fetch, port });
SRCEOF
  pnpm add @hono/node-server
fi

cat > drizzle.config.ts << 'DEOF'
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

cat > src/db/schema.ts << 'SEOF'
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
SEOF

cat > src/db/seed.ts << 'SEEDEOF'
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

cat > tests/setup.ts << 'TSEOF'
import { beforeAll, afterAll } from 'vitest';

beforeAll(() => {
  // Global setup before all tests
});

afterAll(() => {
  // Global cleanup after all tests
});
TSEOF

cat > tests/unit/health.test.ts << 'HTEOF'
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

describe('Health endpoint', () => {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok' }));

  it('should return ok status', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});
HTEOF

success "Initial source files created."


# ---- Platform-specific setup ----
if [[ "$PLATFORM" == "cloudflare" ]]; then
  step "Setting up Cloudflare Workers..."
  pnpm add -D wrangler
  cp "$TEMPLATES_DIR/cloudflare-workers/wrangler.toml" ./wrangler.toml
  success "Cloudflare Workers configured. Edit wrangler.toml with your resource IDs."
else
  step "Setting up Node.js / Docker..."
  cp "$TEMPLATES_DIR/node-server/Dockerfile" ./Dockerfile
  cp "$TEMPLATES_DIR/node-server/docker-compose.yml" ./docker-compose.yml

  cat > .env.example << 'ENVEOF'
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://nerva:nerva_secret@localhost:5432/nerva_db
LOG_LEVEL=debug
ENVEOF

  success "Node.js / Docker configured."
fi

# ---- .gitignore ----
cat > .gitignore << 'GEOF'
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
echo -e "${GREEN} Project created successfully!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  Name:      ${CYAN}$PROJECT_NAME${NC}"
echo -e "  Platform:  ${CYAN}$PLATFORM${NC}"
echo -e "  Location:  ${CYAN}$TARGET_DIR/api${NC}"
echo ""
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
