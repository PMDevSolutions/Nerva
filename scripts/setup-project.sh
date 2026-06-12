#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# setup-project.sh - Initialize a new Nerva API project
# Usage: ./scripts/setup-project.sh <project-name> [--cloudflare|--node|--lambda] [--dry-run]
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
  echo "Usage: $0 <project-name> [--cloudflare|--node|--lambda] [--dry-run]"
  echo "  --cloudflare   Set up for Cloudflare Workers deployment"
  echo "  --node         Set up for Node.js / Docker deployment (default)"
  echo "  --lambda       Set up for AWS Lambda deployment (SAM + API Gateway HTTP API)"
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
    --lambda)     PLATFORM="lambda"; shift ;;
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

DEV_ENTRY="src/index.ts"
LAMBDA_SCRIPTS=""
if [[ "$PLATFORM" == "lambda" ]]; then
  DEV_ENTRY="src/dev.ts"
  LAMBDA_SCRIPTS=$'\n    "build:lambda": "node esbuild.config.mjs",\n    "deploy": "pnpm run build:lambda && sam deploy",'
fi

write_file "$API_DIR/package.json" << PKGJSON
{
  "name": "$PROJECT_NAME",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {$LAMBDA_SCRIPTS
    "dev": "tsx watch $DEV_ENTRY",
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
# NOTE: keep these versions in sync with templates/snippets/package.json — the
# typecheck-templates CI job runs tsc against the snippets using those deps.
run_cmd pnpm add hono drizzle-orm postgres zod @hono/zod-validator
success "Production dependencies installed."

step "Installing dev dependencies..."
# NOTE: @types/node and @cloudflare/workers-types (added per-platform below)
# also live in templates/snippets/package.json — bump in both places.
run_cmd pnpm add -D vitest typescript eslint prettier drizzle-kit @types/node tsx \
  @eslint/js typescript-eslint @vitest/coverage-v8
success "Dev dependencies installed."

step "Creating initial source files..."

if [[ "$PLATFORM" == "cloudflare" ]]; then
  copy_file "$TEMPLATES_DIR/snippets/cloudflare/src/index.ts" "$API_DIR/src/index.ts"
  copy_file "$TEMPLATES_DIR/snippets/cloudflare/src/config.ts" "$API_DIR/src/config.ts"
elif [[ "$PLATFORM" == "lambda" ]]; then
  copy_file "$TEMPLATES_DIR/snippets/aws-lambda/src/index.ts" "$API_DIR/src/index.ts"
  copy_file "$TEMPLATES_DIR/snippets/aws-lambda/src/lambda.ts" "$API_DIR/src/lambda.ts"
  copy_file "$TEMPLATES_DIR/snippets/aws-lambda/src/dev.ts" "$API_DIR/src/dev.ts"
  copy_file "$TEMPLATES_DIR/snippets/aws-lambda/src/config.ts" "$API_DIR/src/config.ts"
  # Local dev server only; production traffic goes through src/lambda.ts
  run_cmd pnpm add @hono/node-server
else
  copy_file "$TEMPLATES_DIR/snippets/node/src/index.ts" "$API_DIR/src/index.ts"
  copy_file "$TEMPLATES_DIR/snippets/node/src/config.ts" "$API_DIR/src/config.ts"
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
copy_file "$TEMPLATES_DIR/snippets/shared/src/db/soft-delete.ts" "$API_DIR/src/db/soft-delete.ts"
copy_file "$TEMPLATES_DIR/snippets/shared/src/db/seed.ts" "$API_DIR/src/db/seed.ts"

if [[ "$PLATFORM" == "cloudflare" ]]; then
  copy_file "$TEMPLATES_DIR/snippets/cloudflare/src/db/ping.ts" "$API_DIR/src/db/ping.ts"
  copy_file "$TEMPLATES_DIR/snippets/cloudflare/src/routes/health.ts" "$API_DIR/src/routes/health.ts"
elif [[ "$PLATFORM" == "lambda" ]]; then
  copy_file "$TEMPLATES_DIR/snippets/aws-lambda/src/db/ping.ts" "$API_DIR/src/db/ping.ts"
  copy_file "$TEMPLATES_DIR/snippets/aws-lambda/src/routes/health.ts" "$API_DIR/src/routes/health.ts"
else
  copy_file "$TEMPLATES_DIR/snippets/node/src/db/ping.ts" "$API_DIR/src/db/ping.ts"
  copy_file "$TEMPLATES_DIR/snippets/node/src/routes/health.ts" "$API_DIR/src/routes/health.ts"
fi

copy_file "$TEMPLATES_DIR/snippets/shared/tests/setup.ts" "$API_DIR/tests/setup.ts"
copy_file "$TEMPLATES_DIR/snippets/shared/tests/soft-delete.test.ts" "$API_DIR/tests/soft-delete.test.ts"

if [[ "$PLATFORM" == "cloudflare" ]]; then
  copy_file "$TEMPLATES_DIR/snippets/cloudflare/tests/unit/health.test.ts" "$API_DIR/tests/unit/health.test.ts"
elif [[ "$PLATFORM" == "lambda" ]]; then
  copy_file "$TEMPLATES_DIR/snippets/aws-lambda/tests/unit/health.test.ts" "$API_DIR/tests/unit/health.test.ts"
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
# Required: at least 32 characters. Generate with: openssl rand -hex 32
JWT_SECRET=replace-me-with-a-secure-32+-character-secret
DVEOF

  success "Cloudflare Workers configured. Edit wrangler.toml with your resource IDs."
elif [[ "$PLATFORM" == "lambda" ]]; then
  step "Setting up AWS Lambda (SAM)..."
  run_cmd pnpm add -D esbuild
  copy_file "$TEMPLATES_DIR/aws-lambda/template.yaml"      "$API_DIR/template.yaml"
  copy_file "$TEMPLATES_DIR/aws-lambda/samconfig.toml"     "$API_DIR/samconfig.toml"
  copy_file "$TEMPLATES_DIR/aws-lambda/esbuild.config.mjs" "$API_DIR/esbuild.config.mjs"
  copy_file "$TEMPLATES_DIR/aws-lambda/docker-compose.yml" "$API_DIR/docker-compose.yml"

  make_dirs "$TARGET_DIR/.github/workflows"
  copy_file "$TEMPLATES_DIR/aws-lambda/deploy.yml" "$TARGET_DIR/.github/workflows/deploy.yml"

  write_file "$API_DIR/.env.example" << 'LENVEOF'
# Local development only -- deployed functions get their environment from
# template.yaml parameters (sam deploy --parameter-overrides).
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://nerva:nerva_secret@localhost:5432/nerva_db
LOG_LEVEL=debug
APP_VERSION=0.0.1
HEALTH_DB_TIMEOUT_MS=2000
# Required in production (min 32 chars). Generate with: openssl rand -hex 32
JWT_SECRET=dev-secret-change-me-in-production-min-32-chars
LENVEOF

  if ! command -v sam &>/dev/null; then
    warn "AWS SAM CLI not found. Install it before deploying:"
    warn "  https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html"
  fi

  success "AWS Lambda configured. Edit samconfig.toml with your stack name and region."
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
# Required in production (min 32 chars). Generate with: openssl rand -hex 32
JWT_SECRET=dev-secret-change-me-in-production-min-32-chars
ENVEOF

  success "Node.js / Docker configured."
fi

# ---- Postman collection ----
step "Generating Postman collection..."

if [[ "$PLATFORM" == "cloudflare" ]]; then
  DEV_BASE_URL="http://localhost:8787"
  PLATFORM_LABEL="Cloudflare Workers"
  DEV_STEPS=$'npx wrangler dev          # start the local dev server'
elif [[ "$PLATFORM" == "lambda" ]]; then
  DEV_BASE_URL="http://localhost:3000"
  PLATFORM_LABEL="AWS Lambda"
  DEV_STEPS=$'docker compose up -d      # start PostgreSQL\npnpm dev                  # start the dev server'
else
  DEV_BASE_URL="http://localhost:3000"
  PLATFORM_LABEL="Node.js / Docker"
  DEV_STEPS=$'docker compose up -d      # start PostgreSQL\npnpm dev                  # start the dev server'
fi

make_dirs "$TARGET_DIR/postman"

write_file "$TARGET_DIR/postman/collection.json" << COLEOF
{
  "info": {
    "name": "$PROJECT_NAME",
    "description": "Starter Postman collection for the $PROJECT_NAME API. Health holds the built-in endpoints and works immediately; Auth and Resources fill in as endpoints are generated. A collection-level pre-request script injects an Authorization header on every request once auth_token is set in the active environment.",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "event": [
    {
      "listen": "prerequest",
      "script": {
        "type": "text/javascript",
        "exec": [
          "// Inject the bearer token when auth_token is set in the active scope",
          "const token = pm.variables.get('auth_token');",
          "if (token) {",
          "  pm.request.headers.upsert({ key: 'Authorization', value: 'Bearer ' + token });",
          "}"
        ]
      }
    }
  ],
  "variable": [
    { "key": "base_url", "value": "$DEV_BASE_URL", "type": "string" },
    { "key": "auth_token", "value": "", "type": "string" }
  ],
  "item": [
    {
      "name": "Health",
      "description": "Built-in service endpoints available immediately after setup.",
      "item": [
        {
          "name": "Health check",
          "event": [
            {
              "listen": "test",
              "script": {
                "type": "text/javascript",
                "exec": [
                  "pm.test('status is 200', function () {",
                  "  pm.response.to.have.status(200);",
                  "});"
                ]
              }
            }
          ],
          "request": {
            "method": "GET",
            "header": [],
            "url": "{{base_url}}/health",
            "description": "Returns service status, including database connectivity."
          },
          "response": []
        },
        {
          "name": "API root",
          "request": {
            "method": "GET",
            "header": [],
            "url": "{{base_url}}/",
            "description": "Returns the API name and version."
          },
          "response": []
        }
      ]
    },
    {
      "name": "Auth",
      "description": "Authentication endpoints. The Login request stores the returned token in the active environment as auth_token, which the collection pre-request script injects on subsequent requests.",
      "item": [
        {
          "name": "Login",
          "event": [
            {
              "listen": "test",
              "script": {
                "type": "text/javascript",
                "exec": [
                  "// Store the token so the collection pre-request script can inject it",
                  "if (pm.response.code === 200) {",
                  "  const body = pm.response.json();",
                  "  const token = body.token || (body.data && body.data.token);",
                  "  if (token) {",
                  "    pm.environment.set('auth_token', token);",
                  "  }",
                  "}"
                ]
              }
            }
          ],
          "request": {
            "method": "POST",
            "header": [
              { "key": "Content-Type", "value": "application/json" }
            ],
            "body": {
              "mode": "raw",
              "raw": "{\n  \"email\": \"user@example.com\",\n  \"password\": \"change-me\"\n}",
              "options": { "raw": { "language": "json" } }
            },
            "url": "{{base_url}}/auth/login",
            "description": "Available once auth endpoints are generated (api-authentication skill or /build-from-schema Phase 4)."
          },
          "response": []
        }
      ]
    },
    {
      "name": "Resources",
      "description": "Generated CRUD endpoints land here. Regenerate this collection from the OpenAPI spec after running /build-from-schema -- see the README for the command.",
      "item": []
    }
  ]
}
COLEOF

write_file "$TARGET_DIR/postman/environment.json" << PMENVEOF
{
  "name": "$PROJECT_NAME (local)",
  "values": [
    {
      "key": "base_url",
      "value": "$DEV_BASE_URL",
      "type": "default",
      "enabled": true
    },
    {
      "key": "auth_token",
      "value": "",
      "type": "secret",
      "enabled": true
    }
  ],
  "_postman_variable_scope": "environment"
}
PMENVEOF

success "Postman collection and environment created."

# ---- Project README ----
step "Generating project README..."

{
  cat << READMEDYN
# $PROJECT_NAME

A Nerva API project for the $PLATFORM_LABEL target. Service code lives in [api/](api/), documentation in [docs/](docs/), and a ready-to-import Postman collection in [postman/](postman/).

## Quickstart

\`\`\`bash
cd api
$DEV_STEPS
pnpm test                 # run the test suite
\`\`\`

The dev server listens at $DEV_BASE_URL -- verify with a GET to /health.
READMEDYN
  if [[ "$PLATFORM" == "lambda" ]]; then
    cat << 'READMELAMBDA'

## Deploying to AWS Lambda

The API deploys as a single Lambda function behind an API Gateway **HTTP API**
(payload format 2.0), defined in `api/template.yaml` (AWS SAM). Hono's
`aws-lambda` adapter (`api/src/lambda.ts`) translates Lambda events into
standard Requests, so the same app code runs locally, in tests, and on Lambda.

```bash
cd api
pnpm build:lambda           # bundle src/lambda.ts -> dist/lambda.mjs (esbuild)
sam deploy --guided         # first deploy: interactive, updates samconfig.toml
pnpm run deploy             # subsequent deploys: build + sam deploy
```

Secrets are `NoEcho` CloudFormation parameters -- pass them at deploy time
instead of committing them:

```bash
sam deploy --parameter-overrides "DatabaseUrl=$DATABASE_URL JwtSecret=$JWT_SECRET"
```

CI/CD: `.github/workflows/deploy.yml` deploys on every push to `main` using
GitHub OIDC (no long-lived AWS keys). The one-time IAM setup is documented in
comments at the top of that file.

### Cold start optimization

The defaults in `api/template.yaml` are chosen with cold starts in mind:

- **Single-file bundle.** esbuild emits one minified `lambda.mjs`, so there is
  no `node_modules` tree to unzip and resolve during init. Keep it that way:
  prefer small dependencies and let tree-shaking work.
- **arm64 (Graviton).** Cheaper per millisecond and generally faster cold
  starts than x86_64.
- **Memory = CPU.** Lambda allocates CPU proportionally to memory; 512 MB is
  the configured floor. If p99 latency matters, benchmark 1024-1769 MB with
  [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) --
  more memory often costs *less* overall because invocations finish sooner.
- **Reuse connections across invocations.** Anything created at module scope
  survives warm invocations. Keep the Postgres pool small (`max: 1` per
  instance) and point `DatabaseUrl` at **RDS Proxy** (or a serverless driver
  such as Neon) so concurrent Lambda instances cannot exhaust database
  connections.
- **Provisioned concurrency** is the lever for latency-critical endpoints --
  `template.yaml` ships a commented block. SnapStart is not available for
  Node.js runtimes.
- **Avoid heavy top-level work.** Defer rarely used SDK clients and remote
  config fetches until first use; top-level code runs inside the billed init
  phase.

### Container-based alternative (Lambda Web Adapter)

To run the Node.js *server* build on Lambda without code changes, package it
as a container image with the
[AWS Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter),
which proxies Lambda events to the HTTP port the server listens on. Useful for
container-only dependencies or bundles beyond the 250 MB zip limit; the
trade-off is slower cold starts than the zip deployment this project uses.
READMELAMBDA
  fi
  cat << 'READMESTATIC'

## Postman

`postman/collection.json` is a Postman Collection (v2.1 format) organized into three folders: **Health** (works immediately), **Auth**, and **Resources** (populated as endpoints are generated). `postman/environment.json` is the matching local environment defining `base_url` and `auth_token`.

To import and run:

1. In Postman, click **Import** and drop in `postman/collection.json` and `postman/environment.json`.
2. Pick the imported environment in the environment selector (top right).
3. With the dev server running, send **Health > Health check**.

Authenticated requests are handled by the collection-level pre-request script: once `auth_token` has a value, every request gets an `Authorization: Bearer <token>` header. The **Auth > Login** request fills `auth_token` automatically from a successful login response; until auth endpoints exist, paste a token into the environment manually.

### Regenerating the collection from an OpenAPI spec

Once the API has an OpenAPI spec (the Nerva pipeline writes one to `docs/openapi.yaml`), regenerate the collection so it covers every endpoint:

```bash
npx --yes --package=openapi-to-postmanv2 openapi2postmanv2 \
  -s docs/openapi.yaml -o postman/collection.json -p \
  -O folderStrategy=Tags
```

In a Nerva framework checkout, `./scripts/generate-openapi-docs.sh` runs this conversion automatically after exporting the spec, and additionally re-applies the `base_url`/`auth_token` variables and the auth pre-request script. Re-import the file in Postman to pick up changes; `postman/environment.json` is never overwritten, so your tokens and URLs survive regeneration.
READMESTATIC
} | write_file "$TARGET_DIR/README.md"

success "README created."

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
.aws-sam/
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
  elif [[ "$PLATFORM" == "lambda" ]]; then
    echo "    docker compose up -d      # Start PostgreSQL"
    echo "    pnpm dev                  # Start dev server"
    echo "    pnpm build:lambda         # Bundle for Lambda"
    echo "    sam deploy --guided       # First AWS deploy"
  else
    echo "    docker compose up -d      # Start PostgreSQL"
    echo "    pnpm dev                  # Start dev server"
  fi
  echo "    pnpm test                 # Run tests"
  echo ""
  echo "  Postman:"
  echo "    Import postman/collection.json and postman/environment.json"
  echo "    to start testing endpoints immediately."
  echo ""
fi
