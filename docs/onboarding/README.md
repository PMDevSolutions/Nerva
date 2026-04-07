# Nerva Documentation

Welcome to the Nerva documentation. Nerva is a Claude Code-integrated API & backend development framework with TypeScript, Hono, Drizzle ORM, and automated schema-to-API pipelines.

## Start Here

| New to Nerva? | Already building? | Contributing? |
|----------------|-------------------|---------------|
| [Quickstart](quickstart.md) | [Pipeline Guide](../schema-to-api/README.md) | [Contributing](../../CONTRIBUTING.md) |
| [Architecture](architecture.md) | [API Standards](../api-development/README.md) | [Code of Conduct](../../CODE_OF_CONDUCT.md) |

## Documentation Map

| Document | Description |
|----------|-------------|
| [Quickstart](quickstart.md) | Get your first API running in minutes |
| [Architecture](architecture.md) | System architecture and component overview |
| [Troubleshooting](troubleshooting.md) | Common issues and solutions |
| [Schema-to-API Pipeline](../schema-to-api/README.md) | 10-phase pipeline deep dive |
| [API Development Standards](../api-development/README.md) | TypeScript, Hono, and testing conventions |
| [Agent Catalog](../../.claude/CUSTOM-AGENTS-GUIDE.md) | All 24 Claude Code agents |
| [Pipeline Configuration](../../.claude/pipeline.config.json) | Pipeline thresholds and settings |
| [Patreon Voting](../community/patreon-voting.md) | Community roadmap voting process |

## Technology Stack

| Component | Technology |
|-----------|------------|
| HTTP Framework | [Hono](https://hono.dev/) |
| ORM | [Drizzle ORM](https://orm.drizzle.team/) |
| Database | PostgreSQL |
| Validation | [Zod](https://zod.dev/) |
| Testing | [Vitest](https://vitest.dev/) + supertest |
| Load Testing | [k6](https://k6.io/) |
| Edge Deployment | [Cloudflare Workers](https://workers.cloudflare.com/) |
| Container Deployment | Docker |
| AI Integration | [Claude Code](https://claude.ai/code) |
