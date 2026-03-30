---
name: api-performance
description: >
  Optimizes API performance through query optimization, caching strategies, and
  connection pooling. Profiles slow queries with EXPLAIN ANALYZE, identifies N+1
  patterns in Drizzle queries, adds caching layers (Workers KV or Redis), tunes
  connection pool settings, and implements response compression. Keywords: performance,
  optimization, query, explain, analyze, n+1, cache, caching, kv, redis, connection-pool,
  slow-query, index, compression, latency, throughput, profiling
---

# API Performance

## Purpose

Optimizes API performance across the full stack: database query optimization,
caching strategies, connection pooling, and response handling. Uses profiling
data from load tests and EXPLAIN ANALYZE to identify bottlenecks and applies
targeted fixes.

## When to Use

- Load tests from Phase 4 show p95 response times exceeding thresholds.
- The user says "optimize", "slow", "performance", "cache", or "n+1".
- Database queries are taking longer than expected.
- The API needs to handle higher concurrency.

## Inputs

| Input | Required | Description |
|---|---|---|
| Load test results | Recommended | From `api-testing-verification` |
| Drizzle schemas | Yes | `api/src/db/schema/*.ts` |
| Service layer | Yes | `api/src/services/*.ts` |

## Steps

### Step 1 -- Profile Slow Queries with EXPLAIN ANALYZE

Identify the slowest queries by adding query logging:

```typescript
// api/src/db/index.ts -- Add query logging
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const client = postgres(process.env.DATABASE_URL!, {
  max: 20,
  idle_timeout: 20,
  connect_timeout: 10,
  debug: (connection, query, params, types) => {
    if (process.env.NODE_ENV === 'development') {
      console.log('Query:', query);
      console.log('Params:', params);
    }
  },
});

export const db = drizzle(client, { schema, logger: true });
```

Run EXPLAIN ANALYZE on suspect queries:

```typescript
// scripts/profile-queries.ts
import { sql } from 'drizzle-orm';
import { db } from '../src/db';

async function profileQuery(name: string, query: string) {
  console.log(`\n--- ${name} ---`);
  const result = await db.execute(
    sql.raw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query}`),
  );
  for (const row of result) {
    console.log((row as any)['QUERY PLAN']);
  }
}

async function main() {
  await profileQuery(
    'List books with pagination',
    `SELECT * FROM books ORDER BY created_at DESC LIMIT 20 OFFSET 0`,
  );

  await profileQuery(
    'Search books by title',
    `SELECT * FROM books WHERE title ILIKE '%search%' ORDER BY created_at DESC LIMIT 20`,
  );

  await profileQuery(
    'Get orders with items for user',
    `SELECT o.*, json_agg(oi.*) as items
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.user_id = '00000000-0000-0000-0000-000000000001'
     GROUP BY o.id
     ORDER BY o.created_at DESC`,
  );

  await profileQuery(
    'Count books (for pagination)',
    `SELECT count(*) FROM books`,
  );

  process.exit(0);
}

main();
```

**Reading EXPLAIN ANALYZE output:**

| Indicator | Meaning | Action |
|---|---|---|
| Seq Scan | Full table scan | Add an index on the WHERE/ORDER column |
| Nested Loop | N+1 pattern | Use JOIN or batch loading |
| Sort | In-memory sort | Add index matching ORDER BY |
| Hash Join | Join using hash table | Usually OK, check memory |
| Rows Removed by Filter | Scanning too many rows | Narrow the scan with an index |
| Buffers: shared hit | Data from cache | Good -- cache is working |
| Buffers: shared read | Data from disk | Consider more RAM or better indexes |

### Step 2 -- Fix N+1 Query Patterns

**Problem: N+1 in Drizzle**

```typescript
// BAD: N+1 pattern -- 1 query for orders + N queries for items
const orders = await db.query.orders.findMany({
  where: eq(orders.userId, userId),
});

for (const order of orders) {
  const items = await db.query.orderItems.findMany({
    where: eq(orderItems.orderId, order.id),
  });
  order.items = items;
}
```

**Fix: Use Drizzle relations (single query with JOIN)**

```typescript
// GOOD: Single query with relations
const ordersWithItems = await db.query.orders.findMany({
  where: eq(orders.userId, userId),
  with: {
    items: {
      with: {
        book: true, // Also load book details
      },
    },
  },
  orderBy: [desc(orders.createdAt)],
  limit: 20,
});
```

**Fix: Manual JOIN for complex queries**

```typescript
// GOOD: Explicit JOIN for full control
import { eq, desc, sql } from 'drizzle-orm';

const result = await db
  .select({
    order: orders,
    itemCount: sql<number>`count(${orderItems.id})::int`,
    totalQuantity: sql<number>`sum(${orderItems.quantity})::int`,
  })
  .from(orders)
  .leftJoin(orderItems, eq(orders.id, orderItems.orderId))
  .where(eq(orders.userId, userId))
  .groupBy(orders.id)
  .orderBy(desc(orders.createdAt))
  .limit(20);
```

**Fix: Batch loading with IN clause**

```typescript
// GOOD: Two queries with IN clause (avoids JOIN overhead)
const orderList = await db.query.orders.findMany({
  where: eq(orders.userId, userId),
  limit: 20,
  orderBy: [desc(orders.createdAt)],
});

const orderIds = orderList.map((o) => o.id);
const items = await db.query.orderItems.findMany({
  where: inArray(orderItems.orderId, orderIds),
  with: { book: true },
});

// Group items by order
const itemsByOrder = new Map<string, typeof items>();
for (const item of items) {
  const group = itemsByOrder.get(item.orderId) ?? [];
  group.push(item);
  itemsByOrder.set(item.orderId, group);
}
```

### Step 3 -- Add Database Indexes

Based on EXPLAIN ANALYZE results, add indexes for frequently queried columns:

```typescript
// api/src/db/schema/books.ts -- add missing indexes
export const books = pgTable(
  'books',
  {
    // ... columns
  },
  (table) => [
    uniqueIndex('books_isbn_idx').on(table.isbn),
    index('books_author_idx').on(table.author),
    index('books_title_idx').on(table.title),
    index('books_created_at_idx').on(table.createdAt),
    // Composite index for common filter + sort patterns
    index('books_author_created_at_idx').on(table.author, table.createdAt),
  ],
);
```

For full-text search, add a GIN index manually:

```sql
-- Custom migration for full-text search
ALTER TABLE books ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title, '') || ' ' ||
      coalesce(author, '') || ' ' ||
      coalesce(description, ''))
  ) STORED;

CREATE INDEX books_search_idx ON books USING GIN (search_vector);
```

Query using the full-text search index:

```typescript
// Full-text search query
const results = await db
  .select()
  .from(books)
  .where(sql`search_vector @@ plainto_tsquery('english', ${searchTerm})`)
  .orderBy(sql`ts_rank(search_vector, plainto_tsquery('english', ${searchTerm})) DESC`)
  .limit(20);
```

### Step 4 -- Implement Caching Layer

**For Cloudflare Workers (KV Cache):**

```typescript
// api/src/middleware/cache.ts
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app';

interface CacheOptions {
  ttl: number; // seconds
  keyPrefix?: string;
  varyBy?: string[]; // query params to include in cache key
}

export function withCache(options: CacheOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const kv = (c.env as any)?.CACHE;
    if (!kv) {
      await next();
      return;
    }

    // Build cache key from URL and specified query params
    const url = new URL(c.req.url);
    const keyParts = [options.keyPrefix ?? '', url.pathname];
    if (options.varyBy) {
      for (const param of options.varyBy.sort()) {
        const value = url.searchParams.get(param);
        if (value) keyParts.push(`${param}=${value}`);
      }
    }
    const cacheKey = keyParts.join(':');

    // Check cache
    const cached = await kv.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    // Execute handler
    await next();

    // Cache successful responses
    if (c.res.status === 200) {
      const body = await c.res.clone().text();
      await kv.put(cacheKey, body, { expirationTtl: options.ttl });
    }
  });
}

// Cache invalidation helper
export async function invalidateCache(kv: KVNamespace, pattern: string) {
  const keys = await kv.list({ prefix: pattern });
  await Promise.all(keys.keys.map((key) => kv.delete(key.name)));
}
```

Usage in routes:

```typescript
// Cache book listing for 60 seconds
router.get(
  '/',
  withCache({
    ttl: 60,
    keyPrefix: 'books',
    varyBy: ['page', 'limit', 'search'],
  }),
  zValidator('query', listBooksQuerySchema),
  async (c) => {
    // handler
  },
);

// Invalidate on writes
router.post('/', requireAuth, requireRole('admin'), async (c) => {
  const book = await service.create(data);
  await invalidateCache((c.env as any).CACHE, 'books');
  return c.json(book, 201);
});
```

**For Node.js (In-Memory LRU Cache):**

```typescript
// api/src/lib/cache.ts
import { LRUCache } from 'lru-cache';

const cache = new LRUCache<string, string>({
  max: 1000,
  ttl: 60 * 1000, // 60 seconds default
  ttlAutopurge: true,
});

export function getCached<T>(key: string): T | undefined {
  const value = cache.get(key);
  return value ? JSON.parse(value) : undefined;
}

export function setCache(key: string, value: unknown, ttlMs?: number): void {
  cache.set(key, JSON.stringify(value), { ttl: ttlMs });
}

export function invalidatePattern(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}
```

### Step 5 -- Connection Pool Tuning

```typescript
// api/src/db/index.ts -- optimized connection pool
import postgres from 'postgres';

const client = postgres(process.env.DATABASE_URL!, {
  // Pool sizing: (2 * CPU cores) + number of disks
  max: parseInt(process.env.DB_POOL_MAX ?? '20', 10),

  // Idle connections are returned after this timeout
  idle_timeout: 20,

  // Maximum time to wait for a connection
  connect_timeout: 10,

  // Maximum lifetime of a connection (force reconnect)
  max_lifetime: 60 * 30, // 30 minutes

  // Prepared statements cache
  prepare: true,

  // Transform column names
  transform: {
    column: { to: postgres.toCamel, from: postgres.fromCamel },
  },
});
```

For Cloudflare Workers with Hyperdrive:

```typescript
// Hyperdrive handles connection pooling automatically
export function createDb(connectionString: string) {
  const client = postgres(connectionString, {
    prepare: false, // Hyperdrive does not support prepared statements
  });
  return drizzle(client, { schema });
}
```

**Connection pool monitoring:**

```sql
-- Check active connections
SELECT count(*) FROM pg_stat_activity WHERE datname = 'myapi';

-- Check connection states
SELECT state, count(*)
FROM pg_stat_activity
WHERE datname = 'myapi'
GROUP BY state;

-- Check for long-running queries
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE (now() - pg_stat_activity.query_start) > interval '5 seconds'
  AND state != 'idle';
```

### Step 6 -- Response Compression

```typescript
// api/src/app.ts
import { compress } from 'hono/compress';

// Enable gzip/brotli compression for responses over 1KB
app.use('*', compress());
```

For Cloudflare Workers, compression is handled automatically by the edge network.

### Step 7 -- Select Only Needed Columns

```typescript
// BAD: selects all columns including large text fields
const users = await db.select().from(usersTable);

// GOOD: select only what the response needs
const users = await db
  .select({
    id: usersTable.id,
    name: usersTable.name,
    email: usersTable.email,
  })
  .from(usersTable);
```

### Step 8 -- Cursor-Based Pagination for Large Datasets

```typescript
// api/src/services/books.service.ts
async listWithCursor(options: {
  limit: number;
  cursor?: string;
  sortOrder: 'asc' | 'desc';
}) {
  const { limit, cursor, sortOrder } = options;

  let query = this.db
    .select()
    .from(books)
    .orderBy(
      sortOrder === 'asc' ? asc(books.createdAt) : desc(books.createdAt),
    )
    .limit(limit + 1); // Fetch one extra to determine hasMore

  if (cursor) {
    query = query.where(
      sortOrder === 'desc'
        ? sql`${books.createdAt} < ${cursor}`
        : sql`${books.createdAt} > ${cursor}`,
    );
  }

  const data = await query;
  const hasMore = data.length > limit;
  if (hasMore) data.pop();

  return {
    data,
    cursor:
      data.length > 0
        ? data[data.length - 1].createdAt?.toISOString()
        : null,
    hasMore,
  };
}
```

## Performance Targets

| Metric | Target | Action if Exceeded |
|---|---|---|
| p50 response time | <50ms | Profile queries |
| p95 response time | <200ms | Add caching or optimize queries |
| p99 response time | <500ms | Check for lock contention |
| Queries per request | <5 | Fix N+1 patterns |
| DB connection usage | <80% pool | Increase pool or optimize |
| Error rate under load | <1% | Check resource limits |

## Output

| Artifact | Location | Description |
|---|---|---|
| Optimized queries | `api/src/services/*.ts` | Refactored with JOINs and proper loading |
| Cache middleware | `api/src/middleware/cache.ts` | KV or in-memory caching |
| Cache utilities | `api/src/lib/cache.ts` | Cache get/set/invalidate helpers |
| Index additions | `api/src/db/schema/*.ts` | New database indexes |
| Pool config | `api/src/db/index.ts` | Tuned connection pool settings |

## Integration

| Skill | Relationship |
|---|---|
| `api-testing-verification` | Load test results trigger optimization work |
| `database-design` | Index and schema changes for performance |
| `database-migrations` | New indexes require migration generation |
| `deployment-config-generator` | Cache bindings (KV) configured in deployment |
| `route-generation` | Cache middleware added to route handlers |
