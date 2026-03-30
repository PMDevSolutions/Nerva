# Custom Agents Guide — Nerva Framework

24 specialized agents for API & backend development. Agents are auto-selected by Claude Code based on task context.

---

## Engineering Agents

### backend-architect (purple)
API architecture decisions, schema design patterns, service layer organization.
- **When to use:** Designing APIs, choosing architectural patterns, database design decisions
- **Key capabilities:** Hono patterns, Drizzle ORM design, microservices vs monolith, edge-first architecture, security architecture

### rapid-prototyper (green)
Quickly scaffold API prototypes, MVPs, and proof-of-concepts.
- **When to use:** Starting a new API from scratch, building an MVP fast, validating an idea
- **Key capabilities:** Quick project setup, core endpoint identification, instant auth, rapid deployment, demo readiness

### test-writer-fixer (cyan)
Write backend tests, run existing tests, analyze and fix failures.
- **When to use:** After code changes need tests, when tests are failing, when coverage needs improvement
- **Key capabilities:** Vitest expertise, supertest for HTTP testing, failure analysis, test repair, coverage optimization

### error-boundary-architect (red)
Design API error handling strategy, typed error classes, consistent error responses.
- **When to use:** Setting up error handling, designing error response format, implementing graceful degradation
- **Key capabilities:** Error class hierarchy, Hono global error handler, circuit breakers, structured logging, error monitoring

### performance-benchmarker (red)
Query profiling, N+1 detection, connection pool tuning, load testing.
- **When to use:** API is slow, load test fails, optimizing database queries, capacity planning
- **Key capabilities:** EXPLAIN ANALYZE, N+1 detection, k6 load testing, connection pool tuning, Workers CPU budgets

### infrastructure-maintainer (gray)
Database management, environment config, dependency updates.
- **When to use:** Managing database operations, updating dependencies, configuring environments, disaster recovery
- **Key capabilities:** Migration management, backup strategies, secret management, monitoring setup, dependency auditing

---

## Schema & Database Agents

### schema-architect (violet)
Translate OpenAPI specs or NL descriptions into Drizzle schemas + Zod validators.
- **When to use:** Starting from an API spec, designing database schema, generating validators
- **Key capabilities:** OpenAPI parsing, Drizzle schema generation, relation mapping, Zod inference, index strategy

### migration-engineer (amber)
Generate, validate, and manage database migrations safely.
- **When to use:** Schema changes needed, reviewing migration safety, planning production migrations
- **Key capabilities:** drizzle-kit workflow, destructive change detection, safe migration patterns, rollback planning, zero-downtime

### data-seeder (olive)
Generate realistic test data, seed scripts, and test fixtures.
- **When to use:** Need test data, setting up development database, creating fixtures for integration tests
- **Key capabilities:** Factory pattern with faker.js, relationship handling, deterministic seeds, bulk generation

---

## API Development Agents

### endpoint-generator (green)
CRUD scaffolding + custom route generation from schema definitions.
- **When to use:** Generating route handlers, scaffolding CRUD endpoints, creating custom business logic routes
- **Key capabilities:** Hono CRUD generation, middleware composition, response formatting, pagination, error handling

### auth-guardian (crimson)
JWT, OAuth2, API keys, RBAC middleware, session management.
- **When to use:** Implementing authentication, adding authorization, managing API keys, setting up RBAC
- **Key capabilities:** JWT with jose, OAuth2 PKCE flow, API key management, role-based middleware, brute force protection

### openapi-documenter (pink)
Auto-generate OpenAPI 3.1 docs, Postman collections, SDK stubs.
- **When to use:** Need API docs, generating Postman collection, setting up interactive docs, creating typed client
- **Key capabilities:** @hono/zod-openapi, Scalar UI, Postman export, openapi-typescript client, changelog

---

## Testing & QA

### api-tester (orange)
Integration testing, contract testing, load testing for APIs.
- **When to use:** Running comprehensive API tests, load testing, validating against OpenAPI spec
- **Key capabilities:** Supertest, k6, contract validation, chaos testing, monitoring setup, performance benchmarks

---

## DevOps

### devops-automator (blue)
Docker, CI/CD pipeline generation, deployment automation.
- **When to use:** Setting up Docker, creating CI/CD, deploying to Cloudflare Workers or Node.js
- **Key capabilities:** Multi-stage Docker, GitHub Actions, wrangler deploy, PM2, health endpoints

---

## Compliance

### legal-compliance-checker (brown)
GDPR endpoints, PII handling, rate limiting, data retention.
- **When to use:** Ensuring regulatory compliance, implementing data export/deletion, setting up audit trails
- **Key capabilities:** GDPR endpoints, PII encryption, data retention policies, security headers, SLA compliance

---

## Product Agents

### sprint-prioritizer (indigo)
Plan development cycles, prioritize API features, manage trade-offs.
- **When to use:** Planning sprints, making feature prioritization decisions, managing scope
- **Key capabilities:** RICE scoring, value vs effort, API-specific trade-offs, risk management

### feedback-synthesizer (lime)
Synthesize API consumer feedback, analyze DX issues.
- **When to use:** Processing feedback from API consumers, improving developer experience
- **Key capabilities:** Pain point analysis, DX scoring, feedback prioritization, action items

### project-shipper (orange)
Ensure API projects ship on time with proper launch preparation.
- **When to use:** Preparing for launch, running pre-deployment checklists, coordinating releases
- **Key capabilities:** Launch checklists, pre-launch audit, deployment coordination, rollback planning

---

## Operations

### analytics-reporter (teal)
API metrics, endpoint usage patterns, error rate analysis.
- **When to use:** Generating health reports, analyzing traffic patterns, capacity planning
- **Key capabilities:** Usage tracking, error analysis, latency monitoring, database performance, business metrics

### studio-producer (magenta)
Project management for API development efforts.
- **When to use:** Managing timelines, allocating resources, tracking dependencies
- **Key capabilities:** Resource allocation, milestone tracking, dependency management, stakeholder communication

---

## Content & Documentation

### content-creator (blue)
API documentation, developer guides, changelogs, integration tutorials.
- **When to use:** Writing docs, creating tutorials, generating changelogs
- **Key capabilities:** API quickstart guides, integration tutorials, error documentation, content strategy

### brand-guardian (gold)
API naming conventions, response consistency, documentation style.
- **When to use:** Ensuring API consistency, reviewing naming conventions, standardizing patterns
- **Key capabilities:** Endpoint naming, error codes, response shapes, header conventions, review checklists

---

## Meta Agents

### joker (yellow)
Tech humor and API puns for lightening the mood.
- **When to use:** Need a laugh, team morale, adding humor to docs

### studio-coach (gold)
Elite performance coach for agent coordination and motivation.
- **When to use:** Complex multi-agent tasks, agents seem stuck, team needs motivation
- **Key capabilities:** Agent optimization, strategic orchestration, motivational leadership, crisis management
