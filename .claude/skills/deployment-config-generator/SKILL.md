---
name: deployment-config-generator
description: >
  Generates deployment configuration based on the target platform specified in
  build-spec.json. For Cloudflare Workers, generates wrangler.toml with bindings.
  For Node.js, generates Dockerfile and docker-compose.yml with PostgreSQL. For
  AWS Lambda, generates a SAM template (API Gateway HTTP API), esbuild bundling
  config, and an OIDC deploy workflow. For Railway, generates railway.toml
  (Dockerfile build, health check, start command) and nixpacks.toml. Always
  generates GitHub Actions CI/CD workflow and .env.example. Keywords: deploy,
  deployment, wrangler, cloudflare, workers, docker, dockerfile, docker-compose,
  aws, lambda, sam, api-gateway, serverless, esbuild, oidc, cold-start, railway,
  nixpacks, paas, github-actions, ci-cd, pipeline, env, configuration,
  infrastructure
---

# Deployment Config Generator (Phase 5)

## Purpose

Generates all deployment configuration files based on the target platform defined
in `build-spec.json`. Produces platform-specific config (wrangler.toml or
Dockerfile), CI/CD pipelines, and environment variable templates. Ensures the
API can be deployed with a single command.

## When to Use

- Phase 4 (api-testing-verification) is complete and the test report verdict is PASS.
- The user says "deploy", "generate config", "wrangler", "docker", or "ci/cd".
- The deployment target changes and configs need regeneration.

## Inputs

| Input | Required | Description |
|---|---|---|
| `build-spec.json` | Yes | `.claude/plans/build-spec.json` with deployment target |
| Test report | Recommended | `.claude/plans/test-report.json` with PASS verdict |

## Steps

### Step 1 -- Read Deployment Target

```typescript
import { readFile } from 'fs/promises';

const spec = JSON.parse(
  await readFile('.claude/plans/build-spec.json', 'utf-8'),
);

const target = spec.deployment.target; // 'cloudflare-workers' | 'node' | 'aws-lambda' | 'railway'
const authStrategy = spec.auth.strategy;
```

### Step 2a -- Cloudflare Workers Configuration

If target is `cloudflare-workers`, generate `wrangler.toml`:

```toml
# api/wrangler.toml
name = "my-api"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[vars]
ENVIRONMENT = "production"

# Hyperdrive for PostgreSQL connection pooling
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<hyperdrive-config-id>"

# D1 database (if using D1 instead of PostgreSQL)
# [[d1_databases]]
# binding = "DB"
# database_name = "my-api-db"
# database_id = "<d1-database-id>"

# KV namespace for caching
[[kv_namespaces]]
binding = "CACHE"
id = "<kv-namespace-id>"

# Rate limiting
# [[unsafe.bindings]]
# name = "RATE_LIMITER"
# type = "ratelimit"
# namespace_id = "1001"
# simple = { limit = 100, period = 60 }

# Secrets (set via wrangler secret put)
# JWT_SECRET
# DATABASE_URL
# REFRESH_SECRET

[env.staging]
name = "my-api-staging"
vars = { ENVIRONMENT = "staging" }

[env.production]
name = "my-api-production"
vars = { ENVIRONMENT = "production" }
routes = [{ pattern = "api.example.com/*", zone_name = "example.com" }]
```

Generate the Workers entry point:

```typescript
// api/src/index.ts (Cloudflare Workers)
import { createApp } from './app';
import { createDb } from './db';

export interface Env {
  HYPERDRIVE: Hyperdrive;
  CACHE: KVNamespace;
  JWT_SECRET: string;
  REFRESH_SECRET: string;
  ENVIRONMENT: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const db = createDb(env.HYPERDRIVE.connectionString);
    const app = createApp({ db, env });
    return app.fetch(request, env, ctx);
  },
};
```

### Step 2b -- Node.js / Docker Configuration

If target is `node`, generate Dockerfile and docker-compose.yml:

```dockerfile
# api/Dockerfile
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Build
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Production
FROM base AS production
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations
COPY package.json ./

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8787/health || exit 1

CMD ["node", "dist/index.js"]
```

```yaml
# docker-compose.yml
services:
  api:
    build:
      context: ./api
      dockerfile: Dockerfile
    ports:
      - "8787:8787"
    environment:
      DATABASE_URL: postgresql://postgres:postgres@db:5432/myapi
      JWT_SECRET: ${JWT_SECRET:-change-me-in-production-at-least-32-chars}
      REFRESH_SECRET: ${REFRESH_SECRET:-change-me-refresh-at-least-32-chars}
      NODE_ENV: production
      PORT: 8787
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - app-network

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: myapi
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    networks:
      - app-network

  migrate:
    build:
      context: ./api
      dockerfile: Dockerfile
      target: build
    command: pnpm drizzle-kit migrate
    environment:
      DATABASE_URL: postgresql://postgres:postgres@db:5432/myapi
    depends_on:
      db:
        condition: service_healthy
    networks:
      - app-network

volumes:
  postgres-data:

networks:
  app-network:
    driver: bridge
```

Node.js entry point:

```typescript
// api/src/index.ts (Node.js)
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { db } from './db';

const app = createApp({ db });

const port = parseInt(process.env.PORT ?? '8787', 10);

console.log(`Starting server on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
```

### Step 2c -- AWS Lambda Configuration

If target is `aws-lambda`, generate a SAM template, esbuild bundling config, and
the Lambda entry point. Canonical templates live in `templates/aws-lambda/`
(`template.yaml`, `samconfig.toml`, `esbuild.config.mjs`, `deploy.yml`,
`docker-compose.yml` for the local dev database).

The Lambda entry point uses Hono's AWS Lambda adapter. The adapter ships inside
the core `hono` package (`hono/aws-lambda`) -- there is no separate package to
install:

```typescript
// api/src/lambda.ts
import { handle } from 'hono/aws-lambda';
import app from './index.js';

export const handler = handle(app);
```

Key pieces of `api/template.yaml`:

```yaml
Globals:
  Function:
    Runtime: nodejs22.x
    Architectures: [arm64]   # Graviton: cheaper, faster cold starts
    MemorySize: 512          # CPU scales with memory; right-size with Power Tuning
    Timeout: 28              # below API Gateway's hard 30s integration timeout

Resources:
  HttpApi:
    Type: AWS::Serverless::HttpApi   # HTTP API (v2), NOT REST API
    Properties:
      StageName: $default

  ApiFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: dist/                 # prebuilt esbuild bundle
      Handler: lambda.handler
      Events:
        Root:
          Type: HttpApi              # no Path/Method = $default catch-all;
          Properties:                # Hono does the routing
            ApiId: !Ref HttpApi
```

Bundling: `esbuild.config.mjs` produces a single minified `dist/lambda.mjs`
(`pnpm build:lambda`). `sam deploy` zips and uploads `dist/` directly -- do not
use `sam build` (its esbuild builder runs npm and conflicts with pnpm).

Add the build/deploy scripts to package.json:

```json
{
  "scripts": {
    "build:lambda": "node esbuild.config.mjs",
    "deploy": "pnpm run build:lambda && sam deploy"
  }
}
```

(Invoke as `pnpm run deploy` -- bare `pnpm deploy` is a pnpm built-in.)

Cold start notes to include in the generated README:

- Single-file esbuild bundle: no node_modules to unzip/resolve at init
- arm64 + memory sizing (CPU scales with memory; benchmark with AWS Lambda
  Power Tuning before raising the 512 MB floor)
- Reuse module-scope DB connections across warm invocations; cap the pool at
  `max: 1` per instance and point DATABASE_URL at RDS Proxy or a serverless
  driver so Lambda concurrency cannot exhaust Postgres connections
- Provisioned concurrency for latency-critical routes (SnapStart is not
  available for Node.js runtimes)
- Container-image alternative: AWS Lambda Web Adapter runs the Node.js server
  build unchanged (useful past the 250 MB zip limit; slower cold starts)

Deployment uses GitHub OIDC (no long-lived AWS keys). Generate
`.github/workflows/deploy.yml` from `templates/aws-lambda/deploy.yml`:

```yaml
permissions:
  id-token: write # required for OIDC federation
  contents: read

# ...

- uses: aws-actions/setup-sam@v2
  with:
    use-installer: true
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
    aws-region: ${{ vars.AWS_REGION }}
- run: >-
    sam deploy --no-confirm-changeset --no-fail-on-empty-changeset
    --parameter-overrides "DatabaseUrl=${{ secrets.DATABASE_URL }} JwtSecret=${{ secrets.JWT_SECRET }}"
```

### Step 2d -- Railway Configuration

If target is `railway`, reuse the Node.js Dockerfile from Step 2b and generate
Railway config-as-code. Canonical templates live in `templates/railway/`
(`railway.toml`, `nixpacks.toml`). Railway builds the service from the
Dockerfile, so the deployed image is identical to the local
`docker compose up` image.

```toml
# api/railway.toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"
watchPatterns = ["src/**", "package.json", "pnpm-lock.yaml", "Dockerfile"]

[deploy]
startCommand = "node dist/index.js"
healthcheckPath = "/health"
healthcheckTimeout = 300
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
numReplicas = 1
```

No deploy workflow is generated: Railway auto-deploys the connected GitHub
repo on every push, gated by the `/health` check. (CLI deploys from CI are
possible with `railway up` and a `RAILWAY_TOKEN` secret, but not required.)

Environment variables live on the Railway service (Variables tab), not in
config files. Generate this reference table into the project README:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference to managed PostgreSQL) |
| `JWT_SECRET` | generated secret, 32+ chars |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |

`PORT` is injected by Railway; the Node.js entry point already binds it.
Remind the user of the one dashboard setting config-as-code cannot express:
service **Root Directory** must be `api` so Railway finds `railway.toml` and
the Dockerfile.

Nixpacks alternative (`builder = "NIXPACKS"`) for building without the
Dockerfile -- `nixpacks.toml` pins the toolchain:

```toml
# api/nixpacks.toml
[phases.setup]
nixPkgs = ["nodejs_22", "pnpm"]

[phases.install]
cmds = ["pnpm install --frozen-lockfile"]

[phases.build]
cmds = ["pnpm build"]

[start]
cmd = "node dist/index.js"
```

### Step 3 -- Generate GitHub Actions CI/CD

```yaml
# .github/workflows/ci.yml
name: CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  NODE_VERSION: '22'

jobs:
  lint-and-type-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: latest
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'
          cache-dependency-path: api/pnpm-lock.yaml
      - run: cd api && pnpm install --frozen-lockfile
      - run: cd api && pnpm type-check
      - run: cd api && pnpm lint

  test:
    runs-on: ubuntu-latest
    needs: lint-and-type-check
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test_db
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: latest
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'
          cache-dependency-path: api/pnpm-lock.yaml
      - run: cd api && pnpm install --frozen-lockfile
      - run: cd api && pnpm vitest run --coverage
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/test_db
          JWT_SECRET: test-secret-key-at-least-32-characters
          REFRESH_SECRET: test-refresh-key-at-least-32-characters
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage
          path: api/coverage/

  deploy-staging:
    runs-on: ubuntu-latest
    needs: test
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: latest
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'
          cache-dependency-path: api/pnpm-lock.yaml
      - run: cd api && pnpm install --frozen-lockfile
      # For Cloudflare Workers:
      - run: cd api && npx wrangler deploy --env staging
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      # For Node.js / Docker:
      # - run: docker build -t myapi:${{ github.sha }} ./api
      # - run: docker push myapi:${{ github.sha }}
      # For AWS Lambda (OIDC -- job also needs `permissions: id-token: write`,
      # see Step 2c):
      # - uses: aws-actions/setup-sam@v2
      # - uses: aws-actions/configure-aws-credentials@v4
      #   with:
      #     role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
      #     aws-region: ${{ vars.AWS_REGION }}
      # - run: cd api && pnpm run build:lambda && sam deploy --no-confirm-changeset
      # For Railway: no deploy step -- Railway auto-deploys the connected
      # GitHub repo on push, gated by the /health check (see Step 2d).

  deploy-production:
    runs-on: ubuntu-latest
    needs: deploy-staging
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: latest
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'
          cache-dependency-path: api/pnpm-lock.yaml
      - run: cd api && pnpm install --frozen-lockfile
      - run: cd api && npx wrangler deploy --env production
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

### Step 4 -- Generate Environment Template

```bash
# .env.example
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/myapi

# Authentication
JWT_SECRET=change-me-must-be-at-least-32-characters-long
REFRESH_SECRET=change-me-must-be-at-least-32-characters-long

# Server
PORT=8787
NODE_ENV=development

# Cloudflare (if applicable)
# CLOUDFLARE_API_TOKEN=your-api-token
# CLOUDFLARE_ACCOUNT_ID=your-account-id
```

### Step 5 -- Generate package.json Scripts

Ensure the API package.json has all necessary scripts:

```json
{
  "scripts": {
    "dev": "wrangler dev",
    "dev:node": "tsx watch src/index.ts",
    "build": "tsc",
    "type-check": "tsc --noEmit",
    "lint": "eslint src/",
    "test": "vitest",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "deploy:staging": "wrangler deploy --env staging",
    "deploy:production": "wrangler deploy --env production"
  }
}
```

## Output

| Artifact | Location | Description |
|---|---|---|
| Wrangler config | `api/wrangler.toml` | Cloudflare Workers deployment |
| Dockerfile | `api/Dockerfile` | Node.js container build |
| Docker Compose | `docker-compose.yml` | Full stack local/prod setup |
| SAM template | `api/template.yaml` | AWS Lambda + API Gateway HTTP API stack |
| SAM config | `api/samconfig.toml` | Stack name, region, deploy defaults |
| esbuild config | `api/esbuild.config.mjs` | Single-file Lambda bundle build |
| Railway config | `api/railway.toml` | Build, health check, start command, restart policy |
| Nixpacks config | `api/nixpacks.toml` | Toolchain pins for the non-Docker Railway build |
| CI/CD workflow | `.github/workflows/ci.yml` | GitHub Actions pipeline |
| Deploy workflow | `.github/workflows/deploy.yml` | OIDC-based AWS Lambda deploy (Lambda target) |
| Env template | `.env.example` | Environment variable template |
| Entry point | `api/src/index.ts` | Platform-specific server bootstrap (plus `api/src/lambda.ts` on Lambda) |

## Integration

| Skill | Relationship |
|---|---|
| `api-testing-verification` (Phase 4) | Tests must pass before deployment |
| `schema-intake` (Phase 0) | Deployment target from build-spec.json |
| `database-migrations` | Migration step in CI/CD pipeline |
| `api-security` | Security headers and CORS configured in deployment |
| `api-performance` | Connection pooling configured per platform |
