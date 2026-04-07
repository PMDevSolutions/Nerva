# Troubleshooting

Common issues and solutions when working with Nerva.

## Setup Issues

### pnpm not found

```
corepack enable
corepack prepare pnpm@latest --activate
```

Requires Node.js 18+. If corepack is not available, install pnpm directly: `npm install -g pnpm`

### Node.js version too old

Nerva requires Node.js 20 or later. Check your version:

```bash
node --version
```

Use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm) to manage Node.js versions.

### PostgreSQL connection refused

Ensure PostgreSQL is running and accessible:

```bash
# Check if PostgreSQL is running
pg_isready

# Or start via Docker
docker-compose up -d postgres
```

Set your connection string in `.env`:
```
DATABASE_URL=postgresql://user:password@localhost:5432/mydb
```

## Pipeline Issues

### "Invalid OpenAPI spec" in Phase 0

Your OpenAPI file has syntax errors or missing required fields.

```bash
# Validate your spec before running the pipeline
npx @apidevtools/swagger-cli validate openapi-spec.yaml
```

Common causes:
- Missing `info.title` or `info.version`
- Invalid YAML indentation
- Broken `$ref` pointers

### Phase 2 tests fail immediately

The TDD gate writes tests before route handlers exist. If they fail for reasons other than "not implemented":

- Ensure database migrations have been applied: `pnpm drizzle-kit migrate`
- Ensure the test database is accessible
- Check that `.env.test` has the correct `DATABASE_URL`

### "Cannot resolve $ref"

Circular or broken schema references in your OpenAPI spec.

- Split circular refs into separate schemas with explicit IDs
- Use `components/schemas/` for all shared definitions
- Avoid deeply nested inline schemas

### Route conflicts in Phase 3

Duplicate or overlapping paths in your OpenAPI spec.

- Check for conflicting patterns (e.g., `/{id}` vs `/me`)
- Ensure each path+method combination is unique
- Use path parameters consistently

### Auth middleware errors in Phase 4

Missing environment variables for authentication.

```bash
# Set required secrets
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
```

## Database Issues

### Migration fails

```bash
# Check migration status
pnpm drizzle-kit status

# Generate a fresh migration
pnpm drizzle-kit generate

# Apply migrations
pnpm drizzle-kit migrate
```

If a migration is stuck, check for:
- Lock conflicts (another process holding the migration lock)
- Schema conflicts (manual changes that diverge from Drizzle schema)

### Connection pool exhaustion

If you see "too many connections" errors:

- Check `max` in your pool configuration (default: 20)
- Ensure connections are properly released after queries
- For Cloudflare Workers, use Hyperdrive for connection pooling

## Deployment Issues

### Wrangler configuration errors

```bash
# Validate wrangler.toml
npx wrangler whoami

# Create D1 database
npx wrangler d1 create my-db

# Update wrangler.toml with the database ID
```

### Docker build fails

Common causes:
- `pnpm-lock.yaml` is in `.dockerignore` (remove it)
- Missing build dependencies in Dockerfile
- Incorrect `WORKDIR` in multi-stage build

```bash
# Build and test locally
docker-compose build
docker-compose up
```

## Claude Code Issues

### Agents not loading

Ensure you're running Claude Code from the Nerva project root directory. Agents are defined in `.claude/agents/` and require Claude Code to be launched from the project directory to be available.

### Skills not found

Skills are in `.claude/skills/` as subdirectories with `SKILL.md` files. They're loaded automatically by Claude Code. If not available:

- Verify Claude Code version is current: `claude --version`
- Check that `.claude/settings.json` or `.claude/settings.local.json` exists
- Restart Claude Code from the project root

### Pipeline stalls or errors

The pipeline writes progress to task tracking. If it stalls:

- Check for error messages in the Claude Code output
- Try resuming: `/build-from-schema spec.yaml --resume`
- Try from a specific phase: `/build-from-schema spec.yaml --from-phase N`
