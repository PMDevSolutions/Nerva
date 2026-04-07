# Changelog

All notable changes to the Nerva framework will be documented in this file.

This changelog is automatically generated from [Conventional Commits](https://www.conventionalcommits.org/).

## 0.5.0 (2026-04-07)

## [0.5.0] - 2026-04-07

### Features

- 24 custom Claude Code agents for backend architecture, database design, testing, security, deployment, and operations
- 12 development skills including schema-to-API pipeline, TDD, authentication, validation, and documentation
- 10-phase autonomous OpenAPI-to-working-API pipeline with enforced TDD gates
- Conversational API builder (`/build-from-conversation`) with structured interview
- Aurelius frontend-to-backend pipeline (`/build-from-aurelius`) for full-stack workflows
- Hono HTTP framework with typed routes, middleware composition, and context typing
- Drizzle ORM schema-first database design with relations, indexes, and migrations
- Dual deployment targets: Cloudflare Workers (edge) and Node.js (Docker)
- Zod request/response validation with type inference
- JWT, OAuth2, and API key authentication patterns
- Contract testing against OpenAPI specification
- k6 load testing script generation
- 9 automation scripts (setup, test, types, security, migration, seed, load test, docs, client generation)
- Starter templates for Cloudflare Workers (wrangler.toml), Node.js (Dockerfile + docker-compose), and shared configs (ESLint, Prettier, TypeScript, Vitest)
- Typed API client generation for Aurelius frontend consumption
- Pipeline configuration with quality gates (80% coverage, TypeScript strict, security audit)
- MIT license, contributing guide, security policy, and code of conduct
