# Database Indexing

How to design indexes for Nerva APIs -- defining them in Drizzle schema files, choosing the right index type for a query, and confirming with `EXPLAIN ANALYZE` that the planner actually uses them.

Indexing is the highest-leverage performance decision in an API and the most common cause of slow ones. An index is a trade: it speeds up the reads that match it, and it taxes every write that touches its columns. Get the set right and a list endpoint reads twenty rows; get it wrong and the same endpoint scans the whole table on every request.

The Phase 1 `database-design` skill generates a baseline -- a B-tree on each foreign key and on `created_at` -- which covers simple lookups. Real workloads need more: composite indexes for multi-column filters, partial indexes for soft-deleted tables, GIN indexes for JSON and search. This guide is the reference for those. The [`performance-benchmarker`](../../.claude/agents/performance-benchmarker.md) agent is its automated counterpart -- it profiles queries, finds missing and unused indexes, and proposes changes from real traffic rather than guesses.

## How Indexes Work, and What They Cost

An index is an auxiliary structure that maps column values to row locations, so the planner can find matching rows without reading the whole table -- a *sequential scan*. Past a few thousand rows, that is the difference between a query that touches a handful of pages and one that reads every page in the table.

Every index has a price. It consumes storage, and every `INSERT`, `UPDATE`, or `DELETE` that changes an indexed column must update the index too. A table with eight indexes does up to eight times the index-maintenance work on each write. The goal is never to index everything -- it is to find the smallest set of indexes that serves the queries you actually run.

Postgres builds some indexes for you and skips others:

- A `PRIMARY KEY` and every `UNIQUE` constraint get a backing B-tree automatically.
- Foreign keys do **not**. Declaring `references(() => users.id)` creates no index on the referencing column, so joins and `ON DELETE CASCADE` scan the child table until you add one. This is why the generated schema indexes foreign keys explicitly.

## Defining Indexes in Drizzle

`pgTable` takes an optional third argument: a callback that receives the table and returns an array of index builders. Import `index` and `uniqueIndex` from `drizzle-orm/pg-core`:

```typescript
// api/src/db/schema/posts.ts
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("draft"),
    title: text("title").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("posts_author_id_idx").on(table.authorId),
  ],
);
```

Name indexes `{table}_{column}_idx`. It matches what Postgres would generate, and it keeps `pg_stat_user_indexes` output readable when you go looking for unused ones later.

Apply index changes through a migration, never with `drizzle-kit push`:

```bash
pnpm drizzle-kit generate   # writes the CREATE INDEX statement to a new migration
pnpm drizzle-kit migrate    # applies it
```

The generate step emits reviewable SQL:

```sql
CREATE INDEX "posts_author_id_idx" ON "posts" USING btree ("author_id");
```

**On a large, live table, building an index takes a lock that blocks writes for the duration of the build.** Use `.concurrently()` to build without that lock, at the cost of a slower build:

```typescript
index("posts_author_id_idx").on(table.authorId).concurrently()
```

One caveat: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and the migration runner wraps each migration in one. Apply a concurrent index as a separate step outside the standard `migrate` flow.

## Single-Column and Composite Indexes

A single-column index serves queries that filter, sort, or join on one column. A composite index spans two or more columns and serves queries that filter on a *leading prefix* of them. With composites, column order is the whole game.

**The leftmost-prefix rule.** An index on `(a, b, c)` serves `WHERE a`, `WHERE a AND b`, `WHERE a AND b AND c`, and `ORDER BY a` or `ORDER BY a, b`. It does **not** serve `WHERE b` alone or `WHERE c`. Order the columns equality-filters first, then the one column you range-scan or sort on.

Take a feed query -- one author's posts, newest first:

```sql
SELECT id, title FROM posts WHERE author_id = $1 ORDER BY published_at DESC LIMIT 20;
```

A composite on `(author_id, published_at DESC)` holds rows grouped by author and already sorted by date, so Postgres walks straight to the author's newest 20 with no separate sort step:

```typescript
(table) => [
  index("posts_author_published_idx").on(table.authorId, table.publishedAt.desc()),
]
```

Matching the index's order to the query's `ORDER BY` is what removes the sort. A query that sorts `author_id ASC, published_at DESC` needs the index to declare those same directions; `.asc()`, `.desc()`, `.nullsFirst()`, and `.nullsLast()` set them per column.

This composite also serves `WHERE author_id = $1` on its own, so a separate single-column index on `author_id` would be redundant -- see [Anti-Patterns](#anti-patterns).

## Unique Indexes and Constraints

There are two ways to enforce uniqueness, and the difference decides which to reach for.

A column-level `.unique()` declares a unique *constraint*, backed automatically by a unique B-tree. Use it for plain "this value appears once" rules:

```typescript
email: text("email").notNull().unique(),
```

`uniqueIndex()` gives you the unique index directly, and it is the only way to express uniqueness that is computed or conditional. Case-insensitive uniqueness needs an expression index -- `.on()` accepts a raw `sql` expression, not just columns:

```typescript
import { sql } from "drizzle-orm";
import { uniqueIndex } from "drizzle-orm/pg-core";

(table) => [
  // Rejects "Ada@example.org" once "ada@example.org" exists, and serves
  // WHERE lower(email) = $1
  uniqueIndex("users_email_lower_idx").on(sql`lower(${table.email})`),
]
```

Two things to know:

- **NULLs are distinct by default.** Postgres treats each NULL as unique, so a unique index permits many NULL rows. To forbid more than one, pass `{ nulls: "not distinct" }` to `.unique()` (Postgres 15+).
- A unique index does double duty -- it enforces the rule *and* is an ordinary B-tree the planner uses for lookups. When a write violates it, Postgres raises error code `23505`; translate that into a [409 `CONFLICT`](./error-handling.md#conflict-409) in the service layer rather than letting it surface as a 500.

## Partial Indexes and Soft Deletes

A partial index covers only the rows matching a `WHERE` predicate. It is smaller than a full index, and the planner uses it whenever a query's filter implies that predicate.

Soft deletes are the textbook case. Nerva tables carry a nullable `deleted_at`; a row is live while `deleted_at IS NULL`, and every read filters deleted rows out through the [`notDeleted()` helper](../../templates/snippets/shared/src/db/soft-delete.ts). A plain index on `email` wastes space indexing deleted rows that no read query wants. A partial index skips them:

```typescript
import { sql } from "drizzle-orm";

(table) => [
  index("users_email_active_idx")
    .on(table.email)
    .where(sql`${table.deletedAt} is null`),
]
```

The predicate must match the query's filter for the planner to use the index. `notDeleted()` emits exactly `deleted_at is null` -- keeping every read aligned with this index is precisely why that helper exists. A query that forgets the filter falls back to a sequential scan.

Partial indexes also fix soft delete's sharp edge. A plain unique constraint on `email` blocks a user from re-registering an address that a *deleted* account still holds. Scope the uniqueness to live rows instead:

```typescript
(table) => [
  uniqueIndex("users_email_active_uq")
    .on(table.email)
    .where(sql`${table.deletedAt} is null`),
]
```

Now an email is unique among active users, and a soft-deleted row keeps its old address without blocking reuse. The same shape fits any hot subset -- an index `WHERE status = 'pending'` on an orders table that is 99% completed stays small no matter how the table grows.

## Choosing an Index Type: B-tree, GIN, GiST

Drizzle selects the access method with `.using(method, ...)`; omit it and you get a B-tree. The method has to match the question the query asks.

| Type | Use for | Drizzle |
|------|---------|---------|
| **B-tree** (default) | Equality and range on scalar, orderable types: `=`, `<`, `>`, `BETWEEN`, `IN`, `ORDER BY`, prefix `LIKE 'foo%'` | `index().on(col)` |
| **GIN** | Values holding many elements queried by containment: `jsonb`, arrays, full-text `tsvector`, trigram substring search | `index().using("gin", col)` |
| **GiST** | Overlap and nearest-neighbour: ranges, geometric/PostGIS types, exclusion constraints | `index().using("gist", col)` |
| **BRIN** | Very large, naturally-ordered tables (append-only logs by `created_at`); tiny, lossy | `index().using("brin", col)` |

Almost every index you write is a B-tree. Reach for the others when the data type calls for it.

**GIN** indexes multi-valued columns. For `jsonb` containment (`metadata @> '{"plan":"pro"}'`):

```typescript
import { index, jsonb, pgTable } from "drizzle-orm/pg-core";

// metadata: jsonb("metadata").notNull().default({})
(table) => [
  index("events_metadata_idx").using("gin", table.metadata),
]
```

B-tree cannot accelerate substring or fuzzy matching (`LIKE '%term%'`, `ILIKE`). A trigram GIN index can. Add the `pg_trgm` extension in a migration first, then set the operator class with `.op()`:

```typescript
(table) => [
  index("posts_title_trgm_idx").using("gin", table.title.op("gin_trgm_ops")),
]
```

**GiST** answers overlap and proximity questions. A bookings table that must reject overlapping reservations uses a GiST exclusion constraint over a `tstzrange`; spatial queries over PostGIS geometries use a GiST index on the geometry column. Rare in CRUD APIs, essential when you need it.

Extensions and operator classes are not optional extras: `pg_trgm` and `postgis` must be installed with `CREATE EXTENSION` (in a migration) before the index referencing them. `.op()` accepts any operator-class string Postgres recognizes, so Drizzle not naming one in its types is never a blocker.

## Index-Only Scans and Covering Indexes

Normally Postgres uses an index to find row locations, then reads each row from the table -- the *heap* -- to fetch the columns the query returns. When every column a query touches (in `SELECT`, `WHERE`, and `ORDER BY`) already lives in the index, it skips the heap entirely. That is an **index-only scan**, and on a hot read path it roughly halves the work.

A composite index you already have can deliver this for free. Given `(author_id, published_at)`, this query answers from the index alone, because both selected columns are in it:

```sql
SELECT author_id, published_at FROM posts WHERE author_id = $1;
```

A **covering index** makes that deliberate with an `INCLUDE` clause: key columns to match and sort on, plus payload columns carried along only to be returned. `INCLUDE` keeps the payload out of the searchable key, so the B-tree stays lean.

Drizzle 0.45.2's index builder exposes `.on()`, `.using()`, `.where()`, `.with()`, and `.concurrently()`, but **no `INCLUDE` clause**. Two ways to get a covering index:

1. **Put the columns in the key** with `.on(authorId, publishedAt, title)`. Simplest, and the right call when you also filter or sort on them. The cost is a wider key that every write maintains.
2. **For a true `INCLUDE`** (payload out of the key), write the index as raw SQL in a custom migration. Scaffold an empty one and add the statement by hand:

   ```bash
   pnpm drizzle-kit generate --custom --name=posts_covering_idx
   ```

   ```sql
   -- api/src/db/migrations/0007_posts_covering_idx.sql
   CREATE INDEX "posts_author_published_covering_idx"
     ON "posts" USING btree ("author_id", "published_at")
     INCLUDE ("title");
   ```

Index-only scans have one more dependency: Postgres must know a row is visible to all transactions without checking the heap, which it tracks in the *visibility map* and keeps current through autovacuum. A table autovacuum has fallen behind on still does heap fetches even with a covering index -- one more reason to keep maintenance healthy.

## Anti-Patterns

Most indexing problems are one of these five.

**Over-indexing.** Every index slows writes and consumes storage, and an index no query uses is pure cost. Find the dead ones:

```sql
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;
```

Drop what nothing reads. (Reset the counters with `pg_stat_reset()` first so the window is meaningful, and confirm the query has run through its real workload.)

**Redundant indexes.** An index on `(author_id)` is redundant once `(author_id, published_at)` exists -- the composite serves the same prefix lookups. Keep the composite, drop the single. And never add an index that duplicates the primary key or a unique constraint; Postgres already created one.

**Low-cardinality columns.** A B-tree on a column with a few distinct values -- a three-state `status`, a boolean flag -- rarely earns its keep. A value matching a third of the table is cheaper to reach by sequential scan than by bouncing between index and heap, so the planner ignores the index and you pay only its write cost. Index the *rare* value with a partial index (`WHERE status = 'failed'`), or fold the column into a composite behind a selective one.

**Unindexed foreign keys.** The opposite mistake, and an easy one because Postgres does not flag it. Joins on the key and `ON DELETE CASCADE` both scan the child table without an index on the referencing column. Index every foreign key you join or cascade on.

**Functions over indexed columns.** `WHERE lower(email) = $1` will not use a plain index on `email` -- wrapping the column in a function makes the stored value and the query value incomparable. Index the expression itself, in the same `lower(email)` form the query uses, as shown under [Unique Indexes and Constraints](#unique-indexes-and-constraints).

## Validating Index Usage with EXPLAIN ANALYZE

An index helps only if the planner chooses it, and the planner is free to ignore one. The only way to know is to read the plan. `EXPLAIN` prints the intended plan; `EXPLAIN ANALYZE` runs the query and prints the plan with real timings and row counts. Add `BUFFERS` to see how many pages were read.

Run it through Drizzle so you measure the exact SQL your app sends:

```typescript
import { sql } from "drizzle-orm";

const plan = await db.execute(
  sql`EXPLAIN (ANALYZE, BUFFERS)
      SELECT id, title FROM posts
      WHERE author_id = ${authorId}
      ORDER BY published_at DESC
      LIMIT 20`,
);
console.log(plan);
```

Read three things in the output:

- **Scan type.** `Seq Scan` on a large table in a selective query means no usable index. `Index Scan` and `Index Only Scan` mean it found and used one; `Bitmap Index Scan` is normal and healthy when many rows match.
- **Estimated vs actual rows.** A wide gap -- the planner expects 10, gets 100,000 -- means stale statistics. Run `ANALYZE <table>` and re-check; the planner makes bad choices from bad estimates.
- **Timing.** `actual time` per node and the final `Execution Time` are the numbers to compare before and after adding an index.

Adding the `(author_id, published_at DESC)` index turns the feed query's plan from this:

```
Seq Scan on posts  (cost=0.00..2891.00 rows=18 ...) (actual time=0.40..51.2 rows=20 ...)
  Filter: (author_id = '...')
  Rows Removed by Filter: 99980
```

into this:

```
Index Only Scan using posts_author_published_idx on posts (actual time=0.02..0.09 rows=20 ...)
  Index Cond: (author_id = '...')
```

Test against realistic data. On a 50-row table a sequential scan genuinely *is* faster, so Postgres picks it and your new index looks unused -- the verdict only means something at production-like volume. Seed first with `./scripts/seed-database.sh`.

For anything past a one-off check -- ranking the slowest queries, catching N+1 query patterns, watching index usage drift over time -- hand off to the [`performance-benchmarker`](../../.claude/agents/performance-benchmarker.md) agent. It enables slow-query logging (`log_min_duration_statement`), reads `pg_stat_statements`, monitors `pg_stat_user_indexes`, and produces index recommendations from real traffic.

## Further Reading

- [PostgreSQL: Indexes](https://www.postgresql.org/docs/current/indexes.html) -- the full chapter, from basics to operator classes
- [PostgreSQL: Index Types](https://www.postgresql.org/docs/current/indexes-types.html) -- B-tree, GIN, GiST, BRIN, and when each applies
- [PostgreSQL: Index-Only Scans and Covering Indexes](https://www.postgresql.org/docs/current/indexes-index-only-scans.html) -- the `INCLUDE` clause and the visibility map
- [PostgreSQL: Partial Indexes](https://www.postgresql.org/docs/current/indexes-partial.html) -- predicate matching and worked examples
- [Drizzle ORM: Indexes & Constraints](https://orm.drizzle.team/docs/indexes-constraints) -- the builder API used throughout this guide
- [Use The Index, Luke](https://use-the-index-luke.com/) -- a deep, practical course on SQL indexing
- [`performance-benchmarker` agent](../../.claude/agents/performance-benchmarker.md) -- automated query profiling and index recommendations
- [API Development Standards](./README.md#performance) -- the performance conventions this guide expands on
