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
import { etag } from 'hono/etag';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { healthRoutes } from './routes/health';
// Note: Response compression is handled automatically by Cloudflare's edge network.
// No compress() middleware is needed for Workers deployments.

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  HYPERDRIVE: Hyperdrive;
  APP_VERSION: string;
  HEALTH_DB_TIMEOUT_MS: string;
  ENVIRONMENT: string;
  LOG_LEVEL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', logger());
app.use('*', cors());
app.use('*', etag());
app.use('*', secureHeaders());
app.use('*', requestId());

app.route('/health', healthRoutes);

app.get('/', (c) => {
  return c.json({ message: 'Nerva API', version: '0.0.1' });
});

export default app;
SRCEOF
else
  write_file "$API_DIR/src/index.ts" << 'SRCEOF'
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { serve } from '@hono/node-server';
import { healthRoutes } from './routes/health';

const app = new Hono();

app.use('*', logger());
app.use('*', cors());
app.use('*', compress());
app.use('*', etag());
app.use('*', secureHeaders());
app.use('*', requestId());

app.route('/health', healthRoutes);

app.get('/', (c) => {
  return c.json({ message: 'Nerva API', version: '0.0.1' });
});

const port = Number(process.env.PORT) || 3000;
console.log(`Server starting on port ${port}`);

const server = serve({ fetch: app.fetch, port });

// --- Graceful shutdown ---
const SHUTDOWN_TIMEOUT_MS = 10_000;
let isShuttingDown = false;

const shutdown = (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n${signal} received. Shutting down gracefully...`);

  const forceExit = setTimeout(() => {
    console.error(`Forced shutdown after ${SHUTDOWN_TIMEOUT_MS / 1000}s timeout.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close(() => {
    console.log('HTTP server closed.');
    // TODO: Close database connection pool when configured
    // await pool.end();
    console.log('Shutdown complete.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
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

write_file "$API_DIR/src/db/client.ts" << 'CEOF'
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const client = postgres(databaseUrl);
export const db = drizzle(client, { schema });
CEOF

write_file "$API_DIR/src/db/seed.ts" << 'SEEDEOF'
import { client, db } from './client.js';
import * as schema from './schema.js';

async function seed(): Promise<void> {
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

if [[ "$PLATFORM" == "cloudflare" ]]; then
  write_file "$API_DIR/src/db/ping.ts" << 'PEOF'
import type { Context } from 'hono';
import postgres from 'postgres';

type Bindings = { HYPERDRIVE: Hyperdrive };

export async function pingDatabase(
  c: Context<{ Bindings: Bindings }>,
): Promise<'connected' | 'disconnected'> {
  if (!c.env.HYPERDRIVE?.connectionString) return 'disconnected';
  const sql = postgres(c.env.HYPERDRIVE.connectionString, {
    max: 1,
    fetch_types: false,
  });
  try {
    await sql`SELECT 1`;
    return 'connected';
  } catch {
    return 'disconnected';
  } finally {
    void sql.end({ timeout: 1 }).catch(() => {});
  }
}
PEOF

  write_file "$API_DIR/src/routes/health.ts" << 'HEOF'
import { Hono } from 'hono';
import { pingDatabase } from '../db/ping';

const startTime = Date.now();

type Bindings = {
  HYPERDRIVE: Hyperdrive;
  APP_VERSION: string;
  HEALTH_DB_TIMEOUT_MS: string;
};

export const healthRoutes = new Hono<{ Bindings: Bindings }>().get('/', async (c) => {
  const timeoutMs = Number(c.env.HEALTH_DB_TIMEOUT_MS) || 2000;
  const timeout = new Promise<'disconnected'>((resolve) =>
    setTimeout(() => resolve('disconnected'), timeoutMs),
  );

  let database: 'connected' | 'disconnected';
  try {
    database = await Promise.race([pingDatabase(c), timeout]);
  } catch {
    database = 'disconnected';
  }

  const status = database === 'connected' ? 'healthy' : 'unhealthy';
  const body = {
    status,
    version: c.env.APP_VERSION ?? 'unknown',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    requestId: c.get('requestId'),
    checks: { database },
  };
  return c.json(body, status === 'healthy' ? 200 : 503);
});
HEOF
else
  write_file "$API_DIR/src/db/ping.ts" << 'PEOF'
import { client } from './client.js';

export async function pingDatabase(): Promise<'connected' | 'disconnected'> {
  try {
    await client`SELECT 1`;
    return 'connected';
  } catch {
    return 'disconnected';
  }
}
PEOF

  write_file "$API_DIR/src/routes/health.ts" << 'HEOF'
import { Hono } from 'hono';
import { pingDatabase } from '../db/ping';

const startTime = Date.now();

export const healthRoutes = new Hono().get('/', async (c) => {
  const timeoutMs = Number(process.env.HEALTH_DB_TIMEOUT_MS) || 2000;
  const timeout = new Promise<'disconnected'>((resolve) =>
    setTimeout(() => resolve('disconnected'), timeoutMs),
  );

  let database: 'connected' | 'disconnected';
  try {
    database = await Promise.race([pingDatabase(), timeout]);
  } catch {
    database = 'disconnected';
  }

  const status = database === 'connected' ? 'healthy' : 'unhealthy';
  const body = {
    status,
    version: process.env.APP_VERSION ?? 'unknown',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    requestId: c.get('requestId'),
    checks: { database },
  };
  return c.json(body, status === 'healthy' ? 200 : 503);
});
HEOF
fi

write_file "$API_DIR/tests/setup.ts" << 'TSEOF'
import { beforeAll, afterAll } from 'vitest';

beforeAll(() => {
  // Global setup before all tests
});

afterAll(() => {
  // Global cleanup after all tests
});
TSEOF

if [[ "$PLATFORM" == "cloudflare" ]]; then
  write_file "$API_DIR/tests/unit/health.test.ts" << 'HTEOF'
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { pingDatabase } from '../../src/db/ping';
import { healthRoutes } from '../../src/routes/health';

vi.mock('../../src/db/ping', () => ({
  pingDatabase: vi.fn(),
}));

interface HealthBody {
  status: 'healthy' | 'unhealthy';
  version: string;
  uptime: number;
  timestamp: string;
  requestId: string;
  checks: { database: 'connected' | 'disconnected' };
}

type TestEnv = {
  APP_VERSION: string;
  HEALTH_DB_TIMEOUT_MS: string;
  HYPERDRIVE: Hyperdrive | undefined;
};

const env: TestEnv = {
  APP_VERSION: '0.0.1',
  HEALTH_DB_TIMEOUT_MS: '2000',
  HYPERDRIVE: undefined,
};

const makeApp = () => {
  const app = new Hono<{ Bindings: TestEnv }>();
  app.use('*', requestId());
  app.route('/health', healthRoutes);
  return app;
};

const mockedPing = vi.mocked(pingDatabase);

describe('Health endpoint', () => {
  beforeEach(() => {
    mockedPing.mockReset();
  });

  it('returns 200 + healthy when DB is connected', async () => {
    mockedPing.mockResolvedValue('connected');
    const res = await makeApp().request('/health', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('healthy');
    expect(body.checks.database).toBe('connected');
  });

  it('returns version from APP_VERSION binding', async () => {
    mockedPing.mockResolvedValue('connected');
    const res = await makeApp().request('/health', {}, env);
    const body = (await res.json()) as HealthBody;
    expect(body.version).toBe('0.0.1');
  });

  it('returns numeric uptime >= 0', async () => {
    mockedPing.mockResolvedValue('connected');
    const res = await makeApp().request('/health', {}, env);
    const body = (await res.json()) as HealthBody;
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 + unhealthy when DB is disconnected', async () => {
    mockedPing.mockResolvedValue('disconnected');
    const res = await makeApp().request('/health', {}, env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('unhealthy');
    expect(body.checks.database).toBe('disconnected');
  });

  it('returns 503 when ping exceeds timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockedPing.mockImplementation(() => new Promise(() => {}));
    const reqPromise = makeApp().request('/health', {}, env);
    await vi.advanceTimersByTimeAsync(2001);
    const res = await reqPromise;
    expect(res.status).toBe(503);
    vi.useRealTimers();
  });

  it('returns 503 when ping throws (never 500)', async () => {
    mockedPing.mockRejectedValue(new Error('boom'));
    const res = await makeApp().request('/health', {}, env);
    expect(res.status).toBe(503);
  });

  it('preserves requestId in body and X-Request-Id header', async () => {
    mockedPing.mockResolvedValue('connected');
    const res = await makeApp().request('/health', {}, env);
    const body = (await res.json()) as HealthBody;
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(res.headers.get('X-Request-Id')).not.toBeNull();
  });
});
HTEOF
else
  write_file "$API_DIR/tests/unit/health.test.ts" << 'HTEOF'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { pingDatabase } from '../../src/db/ping';
import { healthRoutes } from '../../src/routes/health';

vi.mock('../../src/db/ping', () => ({
  pingDatabase: vi.fn(),
}));

interface HealthBody {
  status: 'healthy' | 'unhealthy';
  version: string;
  uptime: number;
  timestamp: string;
  requestId: string;
  checks: { database: 'connected' | 'disconnected' };
}

const makeApp = () => {
  const app = new Hono();
  app.use('*', requestId());
  app.route('/health', healthRoutes);
  return app;
};

const mockedPing = vi.mocked(pingDatabase);

beforeAll(() => {
  process.env.APP_VERSION = '0.0.1';
  process.env.HEALTH_DB_TIMEOUT_MS = '2000';
});

describe('Health endpoint', () => {
  beforeEach(() => {
    mockedPing.mockReset();
  });

  it('returns 200 + healthy when DB is connected', async () => {
    mockedPing.mockResolvedValue('connected');
    const res = await makeApp().request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('healthy');
    expect(body.checks.database).toBe('connected');
  });

  it('returns version from APP_VERSION env', async () => {
    mockedPing.mockResolvedValue('connected');
    const res = await makeApp().request('/health');
    const body = (await res.json()) as HealthBody;
    expect(body.version).toBe('0.0.1');
  });

  it('returns numeric uptime >= 0', async () => {
    mockedPing.mockResolvedValue('connected');
    const res = await makeApp().request('/health');
    const body = (await res.json()) as HealthBody;
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 + unhealthy when DB is disconnected', async () => {
    mockedPing.mockResolvedValue('disconnected');
    const res = await makeApp().request('/health');
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('unhealthy');
    expect(body.checks.database).toBe('disconnected');
  });

  it('returns 503 when ping exceeds timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockedPing.mockImplementation(() => new Promise(() => {}));
    const reqPromise = makeApp().request('/health');
    await vi.advanceTimersByTimeAsync(2001);
    const res = await reqPromise;
    expect(res.status).toBe(503);
    vi.useRealTimers();
  });

  it('returns 503 when ping throws (never 500)', async () => {
    mockedPing.mockRejectedValue(new Error('boom'));
    const res = await makeApp().request('/health');
    expect(res.status).toBe(503);
  });

  it('preserves requestId in body and X-Request-Id header', async () => {
    mockedPing.mockResolvedValue('connected');
    const res = await makeApp().request('/health');
    const body = (await res.json()) as HealthBody;
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(res.headers.get('X-Request-Id')).not.toBeNull();
  });
});
HTEOF
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
