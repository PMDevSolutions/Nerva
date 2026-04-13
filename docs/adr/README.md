# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Nerva framework. ADRs document the reasoning behind significant architectural choices, helping contributors understand not just what was decided, but why.

## Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [000](000-template.md) | ADR Template | — | — |
| [001](001-hono-over-express.md) | Hono as HTTP Framework Over Express | Accepted | 2026-03-29 |
| [002](002-drizzle-over-prisma.md) | Drizzle ORM Over Prisma and TypeORM | Accepted | 2026-03-29 |
| [003](003-tdd-mandatory-gate.md) | TDD as a Mandatory Pipeline Gate | Accepted | 2026-03-29 |

## Creating a New ADR

1. Copy [000-template.md](000-template.md) to `NNN-title.md` (next sequential number, kebab-case title).
2. Fill in all sections — the **Context** section is the most valuable part.
3. Set status to **Proposed** and open a pull request.
4. Once merged, update status to **Accepted** and set the date.
5. Add an entry to the index table above.

## Further Reading

- [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) by Michael Nygard (the original ADR proposal)
