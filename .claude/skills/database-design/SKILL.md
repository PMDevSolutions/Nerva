---
name: database-design
description: >
  Generates Drizzle ORM schemas and an initial database migration from the build-spec.json
  produced by schema-intake. Creates one schema file per table, defines relations, adds
  indexes, generates Zod validators, and runs drizzle-kit generate for the initial
  migration. Use this skill after Phase 0 completes. Keywords: drizzle, orm, schema,
  database, postgresql, postgres, migration, table, relation, index, zod, pgTable,
  db-design, models, columns, foreign-key, enum
---

# Database Design (Phase 1)

## Purpose

Transforms the canonical `build-spec.json` into production-ready Drizzle ORM schema
files with relations, indexes, enums, and corresponding Zod validation schemas. Also
generates the initial database migration using `drizzle-kit generate`.

## When to Use

- Phase 0 (schema-intake) has completed and `.claude/plans/build-spec.json` exists.
- The user asks to "generate database schemas", "create tables", or "set up the database".
- A model has been added or changed in the build-spec and schemas need regeneration.

## Inputs

| Input | Required | Description |
|---|---|---|
| `build-spec.json` | Yes | Located at `.claude/plans/build-spec.json` |
| `drizzle.config.ts` | No | Existing Drizzle config (will be created if missing) |

## Steps

### Step 1 -- Read and Validate build-spec.json

```typescript
import { readFile } from 'fs/promises';
import path from 'path';

const specPath = path.join(process.cwd(), '.claude', 'plans', 'build-spec.json');
const spec: BuildSpec = JSON.parse(await readFile(specPath, 'utf-8'));

// Validate required sections exist
if (!spec.models?.length) {
  throw new Error('build-spec.json contains no models. Run schema-intake first.');
}
```

### Step 2 -- Ensure Project Structure

Create the required directories if they do not exist:

```
api/
  src/
    db/
      schema/          <-- one file per table
        index.ts       <-- barrel export
      migrations/      <-- drizzle-kit output
      index.ts         <-- database connection
    validators/        <-- Zod schemas
      index.ts
  drizzle.config.ts
```

```bash
mkdir -p api/src/db/schema
mkdir -p api/src/db/migrations
mkdir -p api/src/validators
```

### Step 3 -- Generate Drizzle Config

If `api/drizzle.config.ts` does not exist, create it:

```typescript
// api/drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './src/db/migrations',
  schema: './src/db/schema/index.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
```

### Step 4 -- Generate Database Connection

```typescript
// api/src/db/index.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// For Cloudflare Workers, use drizzle-orm/neon-http or hyperdrive instead
const connectionString = process.env.DATABASE_URL!;
const client = postgres(connectionString);

export const db = drizzle(client, { schema });
export type Database = typeof db;
```

For Cloudflare Workers deployment target:

```typescript
// api/src/db/index.ts (Cloudflare Workers variant)
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema';

export function createDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema });
}

export type Database = ReturnType<typeof createDb>;
```

### Step 5 -- Generate Enum Types

For any model field with a constrained set of values, generate a pgEnum:

```typescript
// api/src/db/schema/enums.ts
import { pgEnum } from 'drizzle-orm/pg-core';

// Example: role enum derived from build-spec
export const userRoleEnum = pgEnum('user_role', ['admin', 'manager', 'customer']);

// Example: order status enum
export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'confirmed',
  'shipped',
  'delivered',
  'cancelled',
]);
```

### Step 6 -- Generate Schema Files (One Per Table)

For each model in `build-spec.json`, generate a Drizzle schema file.

**Type Mapping Reference:**

| build-spec pgType | Drizzle Column Builder |
|---|---|
| `uuid` | `uuid('col').defaultRandom()` |
| `text` | `text('col')` |
| `integer` | `integer('col')` |
| `bigint` | `bigint('col', { mode: 'number' })` |
| `numeric` | `numeric('col', { precision: 10, scale: 2 })` |
| `boolean` | `boolean('col')` |
| `timestamp` | `timestamp('col', { withTimezone: true })` |
| `date` | `date('col')` |
| `jsonb` | `jsonb('col')` |
| `real` | `real('col')` |
| `doublePrecision` | `doublePrecision('col')` |

**Example: Users Table**

```typescript
// api/src/db/schema/users.ts
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { userRoleEnum } from './enums';
import { orders } from './orders';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: userRoleEnum('role').default('customer').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('users_email_idx').on(table.email),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  orders: many(orders),
}));
```

**Example: Orders Table (with foreign key)**

```typescript
// api/src/db/schema/orders.ts
import {
  pgTable,
  uuid,
  numeric,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { orderStatusEnum } from './enums';
import { users } from './users';
import { orderItems } from './order-items';

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: orderStatusEnum('status').default('pending').notNull(),
    total: numeric('total', { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('orders_user_id_idx').on(table.userId),
    index('orders_status_idx').on(table.status),
  ],
);

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, {
    fields: [orders.userId],
    references: [users.id],
  }),
  items: many(orderItems),
}));
```

**Example: Books Table**

```typescript
// api/src/db/schema/books.ts
import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { orderItems } from './order-items';

export const books = pgTable(
  'books',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    author: text('author').notNull(),
    isbn: text('isbn').notNull(),
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    stock: integer('stock').default(0).notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('books_isbn_idx').on(table.isbn),
    index('books_author_idx').on(table.author),
    index('books_title_idx').on(table.title),
  ],
);

export const booksRelations = relations(books, ({ many }) => ({
  orderItems: many(orderItems),
}));
```

**Example: Join/Pivot Table (OrderItems)**

```typescript
// api/src/db/schema/order-items.ts
import {
  pgTable,
  uuid,
  integer,
  numeric,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { orders } from './orders';
import { books } from './books';

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('order_items_order_id_idx').on(table.orderId),
    index('order_items_book_id_idx').on(table.bookId),
  ],
);

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
  book: one(books, {
    fields: [orderItems.bookId],
    references: [books.id],
  }),
}));
```

### Step 7 -- Generate Barrel Export

```typescript
// api/src/db/schema/index.ts
export * from './enums';
export * from './users';
export * from './books';
export * from './orders';
export * from './order-items';
```

### Step 8 -- Generate Zod Validators

Use `drizzle-zod` to create insert/select/update schemas:

```typescript
// api/src/validators/users.ts
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { users } from '../db/schema/users';

// Base schemas inferred from Drizzle table
export const insertUserSchema = createInsertSchema(users, {
  email: z.string().email('Invalid email address'),
  name: z.string().min(1, 'Name is required').max(100),
  role: z.enum(['admin', 'manager', 'customer']).optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  passwordHash: true,
});

export const selectUserSchema = createSelectSchema(users).omit({
  passwordHash: true,
});

export const updateUserSchema = insertUserSchema.partial();

// Registration schema (includes password)
export const registerUserSchema = insertUserSchema.extend({
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

// Login schema
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Type inference
export type InsertUser = z.infer<typeof insertUserSchema>;
export type SelectUser = z.infer<typeof selectUserSchema>;
export type UpdateUser = z.infer<typeof updateUserSchema>;
```

```typescript
// api/src/validators/books.ts
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { books } from '../db/schema/books';

export const insertBookSchema = createInsertSchema(books, {
  title: z.string().min(1).max(500),
  author: z.string().min(1).max(200),
  isbn: z.string().regex(/^(97[89])?\d{9}(\d|X)$/, 'Invalid ISBN'),
  price: z.string().regex(/^\d+\.\d{2}$/, 'Price must have exactly 2 decimal places'),
  stock: z.number().int().min(0).optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const selectBookSchema = createSelectSchema(books);

export const updateBookSchema = insertBookSchema.partial();

// Query params for list endpoint
export const listBooksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  author: z.string().optional(),
  sortBy: z.enum(['title', 'author', 'price', 'createdAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type InsertBook = z.infer<typeof insertBookSchema>;
export type SelectBook = z.infer<typeof selectBookSchema>;
export type UpdateBook = z.infer<typeof updateBookSchema>;
export type ListBooksQuery = z.infer<typeof listBooksQuerySchema>;
```

```typescript
// api/src/validators/index.ts
export * from './users';
export * from './books';

// Shared schemas
import { z } from 'zod';

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const uuidParamSchema = z.object({
  id: z.string().uuid('Invalid ID format'),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

// Pagination response wrapper
export const paginatedResponseSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({
    data: z.array(itemSchema),
    meta: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
  });
```

### Step 9 -- Run Initial Migration

```bash
# Generate migration from schema
cd api && npx drizzle-kit generate

# This creates a migration file in api/src/db/migrations/
# Example output: 0000_initial_schema.sql
```

Verify the generated SQL:

```bash
# Review the migration file
cat api/src/db/migrations/0000_*.sql
```

The generated SQL should contain:

```sql
CREATE TYPE "user_role" AS ENUM('admin', 'manager', 'customer');
CREATE TYPE "order_status" AS ENUM('pending', 'confirmed', 'shipped', 'delivered', 'cancelled');

CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "name" text NOT NULL,
  "role" "user_role" DEFAULT 'customer' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "books" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "author" text NOT NULL,
  "isbn" text NOT NULL,
  "price" numeric(10, 2) NOT NULL,
  "stock" integer DEFAULT 0 NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" "order_status" DEFAULT 'pending' NOT NULL,
  "total" numeric(10, 2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "order_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "book_id" uuid NOT NULL REFERENCES "books"("id") ON DELETE RESTRICT,
  "quantity" integer NOT NULL,
  "unit_price" numeric(10, 2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "books_isbn_idx" ON "books" USING btree ("isbn");
CREATE INDEX IF NOT EXISTS "books_author_idx" ON "books" USING btree ("author");
CREATE INDEX IF NOT EXISTS "orders_user_id_idx" ON "orders" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "order_items_order_id_idx" ON "order_items" USING btree ("order_id");
CREATE INDEX IF NOT EXISTS "order_items_book_id_idx" ON "order_items" USING btree ("book_id");
```

### Step 10 -- Install Dependencies

```bash
cd api && pnpm add drizzle-orm postgres @neondatabase/serverless
cd api && pnpm add -D drizzle-kit drizzle-zod
```

## Output

| Artifact | Location | Description |
|---|---|---|
| Schema files | `api/src/db/schema/*.ts` | One Drizzle pgTable per model |
| Enum definitions | `api/src/db/schema/enums.ts` | PostgreSQL enum types |
| Schema barrel | `api/src/db/schema/index.ts` | Re-exports all schemas |
| DB connection | `api/src/db/index.ts` | Drizzle client setup |
| Zod validators | `api/src/validators/*.ts` | Insert/select/update schemas |
| Drizzle config | `api/drizzle.config.ts` | Migration configuration |
| Initial migration | `api/src/db/migrations/0000_*.sql` | Generated SQL migration |

## Integration

| Skill | Relationship |
|---|---|
| `schema-intake` (Phase 0) | Reads build-spec.json produced by Phase 0 |
| `tdd-from-schema` (Phase 2) | Uses schema types and validators to write tests |
| `route-generation` (Phase 3) | Imports schemas for query building and validators for request validation |
| `api-validation` | Extends the Zod validators generated here |
| `database-migrations` | Manages subsequent migrations after the initial one |
| `api-authentication` | May add auth-related columns to the users table |

### Design Decisions

- **One file per table**: Keeps schemas maintainable and reduces merge conflicts.
- **Relations defined alongside tables**: Co-locating relations with their table makes the data model self-documenting.
- **Zod inference from Drizzle**: Single source of truth -- change the Drizzle schema, the Zod validators follow automatically.
- **UUID primary keys**: Default for all tables. Avoids sequential ID enumeration attacks and works well in distributed systems.
- **Soft timestamps**: `createdAt` and `updatedAt` on every table. `$onUpdate` handles automatic timestamp refresh.
- **snake_case columns**: PostgreSQL convention. Drizzle maps to camelCase in TypeScript automatically.
