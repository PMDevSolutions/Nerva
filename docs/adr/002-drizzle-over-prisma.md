# ADR-002: Drizzle ORM Over Prisma and TypeORM

## Status

Accepted

## Date

2026-03-29

## Context

Nerva's schema-to-API pipeline needs an ORM or query builder that can:

1. **Define the database schema in TypeScript** — the schema serves as the single source of truth for migrations, Zod validators, and TypeScript types.
2. **Run on Cloudflare Workers** — the primary deployment target has no persistent filesystem, limited CPU time, and no support for native Node.js addons.
3. **Generate SQL migrations** — schema changes must produce reviewable SQL files that can be version-controlled and rolled back.
4. **Integrate with Zod** — the pipeline derives runtime validators from the database schema via `drizzle-zod`.

Alternatives considered:

- **Prisma** — The most popular TypeScript ORM. Generates types from a `.prisma` schema file (not TypeScript). Requires a binary query engine (~15MB) that cannot run in Cloudflare Workers without WASM workarounds. The Prisma schema is a separate DSL, meaning the database definition lives outside TypeScript and cannot be directly referenced by other pipeline stages.
- **TypeORM** — Mature ORM with decorator-based entity definitions. Relies heavily on `reflect-metadata` and runtime decorators, which add overhead and complexity. TypeScript support is weaker than Drizzle or Prisma — many operations return `any` or require manual casting. No native edge runtime support.
- **Kysely** — Lightweight, type-safe query builder. Strong TypeScript inference but does not provide schema definition or migration generation — those would need to be handled separately, adding complexity to the pipeline.

## Decision

Use **Drizzle ORM** as the database layer for all generated APIs.

Drizzle provides a TypeScript-native schema definition API, a type-safe query builder, automatic migration generation via `drizzle-kit`, and a `drizzle-zod` package that derives Zod schemas directly from table definitions. It has zero runtime dependencies beyond the database driver.

## Consequences

### Positive

- **Schema is TypeScript.** Table definitions are plain TypeScript objects, making them importable by other pipeline stages (Zod generation, type exports, test fixtures).
- **Zero runtime overhead.** No query engine binary, no proxy objects, no reflection. Drizzle compiles to direct SQL — critical for Workers CPU limits.
- **`drizzle-zod` integration.** `createInsertSchema(users)` generates a Zod validator directly from the table definition, keeping validation and schema in sync without manual duplication.
- **Type-safe joins and relations.** `relations()` definitions enable typed eager loading without the N+1 query traps that implicit ORM loading can introduce.
- **SQL-transparent.** Drizzle's query builder maps closely to SQL. Developers can reason about the generated queries, which makes performance tuning straightforward.
- **Migration generation.** `drizzle-kit generate` produces SQL migration files from schema diffs, enabling version-controlled, reviewable database changes.

### Negative

- **Less batteries-included than Prisma.** No built-in GUI studio equivalent to Prisma Studio in production workflows (though `drizzle-kit studio` exists for development). No built-in connection pooling management — this is handled separately (via `pg` Pool or Cloudflare Hyperdrive).
- **Smaller community.** Less third-party tooling and fewer tutorials than Prisma. The documentation, while improving, is less comprehensive.
- **SQL knowledge expected.** Because Drizzle maps closely to SQL, developers need to understand SQL concepts (joins, subqueries, indexes) rather than relying on ORM abstractions to hide them.

### Neutral

- Drizzle supports PostgreSQL, MySQL, and SQLite. Nerva defaults to PostgreSQL but the schema definitions are portable if a project needs a different database.
