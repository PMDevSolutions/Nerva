# Quickstart

Get your first API running with Nerva.

## Prerequisites

- **Node.js** 20 or later
- **pnpm** 9 or later
- **Claude Code** ([claude.ai/code](https://claude.ai/code)) — required for agents and skills
- **PostgreSQL** 15+ (or Docker for local development)

### Installing pnpm

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

## Installation

```bash
git clone https://github.com/PMDevSolutions/Nerva.git
cd Nerva
pnpm install
```

## Creating Your First API

### Option 1: From an OpenAPI Spec (Recommended)

If you have an OpenAPI specification file:

```bash
# Initialize the project structure
./scripts/setup-project.sh my-api --cloudflare   # or --node

# Open Claude Code and run the pipeline
/build-from-schema path/to/openapi-spec.yaml
```

The pipeline runs 10 phases autonomously:
1. Parses your OpenAPI spec
2. Generates Drizzle database schemas
3. Writes failing integration tests (TDD gate)
4. Generates Hono route handlers that pass the tests
5. Adds authentication and middleware
6. Runs integration, contract, and load tests
7. Generates API documentation
8. Runs quality gates (types, coverage, security)
9. Generates deployment configuration
10. Produces a build report

### Option 2: From Conversation

If you don't have an OpenAPI spec yet:

```
/build-from-conversation
```

Claude Code walks you through a structured interview (7-10 questions) about your API requirements, generates an OpenAPI spec, and then runs the pipeline above.

### Option 3: From an Aurelius Frontend

If you built a frontend with [Aurelius](https://github.com/PMDevSolutions/Aurelius):

```
/build-from-aurelius path/to/build-spec.json
```

This reads the frontend's data requirements and generates a matching backend API.

## Running the Development Server

```bash
cd api

# Cloudflare Workers target
npx wrangler dev                    # http://localhost:8787

# Node.js target
pnpm dev                            # http://localhost:3000
```

## Running Tests

```bash
./scripts/run-tests.sh              # Full test suite with coverage
./scripts/check-types.sh            # TypeScript type checking
./scripts/security-scan.sh          # Security audit
```

## What's Next

- [Pipeline Guide](../schema-to-api/README.md) — understand each pipeline phase in depth
- [API Development Standards](../api-development/README.md) — coding conventions and patterns
- [Agent Catalog](../../.claude/CUSTOM-AGENTS-GUIDE.md) — discover what the 24 agents can do
