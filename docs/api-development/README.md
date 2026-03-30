# API Development Standards

Development standards and patterns for building APIs with the Nerva framework.

## TypeScript Standards

### Strict Mode

All projects use `strict: true` in `tsconfig.json`. No exceptions.

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

### No `any`

Never use `any`. Use `unknown` when the type is genuinely not known, then narrow with type guards:

```typescript
// Bad
function parseBody(body: any) { /* ... */ }

// Good
function parseBody(body: unknown): ParsedBody {
  const parsed = bodySchema.parse(body);
  return parsed;
}
```

### Zod for Runtime Validation

All external input (request bodies, query params, headers) must be validated with Zod schemas:

```typescript
import { z } from "zod";

export const createTodoSchema = z.object({
  title: z.string().min(1).max(255),
  completed: z.boolean().default(false),
});

export type CreateTodoInput = z.infer<typeof createTodoSchema>;
```

### Drizzle Type Inference

Derive types from Drizzle schemas rather than duplicating definitions:

```typescript
import { todos } from "../db/schema/todos";
import { InferSelectModel, InferInsertModel } from "drizzle-orm";

export type Todo = InferSelectModel<typeof todos>;
export type NewTodo = InferInsertModel<typeof todos>;
```

## Hono Patterns

### Route Grouping

Group routes by resource using `Hono.route()`:

```typescript
import { Hono } from "hono";
import { todosRoutes } from "./routes/todos";
import { usersRoutes } from "./routes/users";

const app = new Hono();

app.route("/api/v1/todos", todosRoutes);
app.route("/api/v1/users", usersRoutes);
```

### Middleware Composition

Stack middleware in order -- auth before validation before handler:

```typescript
import { zValidator } from "@hono/zod-validator";
import { jwt } from "hono/jwt";

const todosRoutes = new Hono();

todosRoutes.post(
  "/",
  jwt({ secret: env.JWT_SECRET }),
  zValidator("json", createTodoSchema),
  async (c) => {
    const input = c.req.valid("json");
    const todo = await todoService.create(input);
    return c.json(todo, 201);
  }
);
```

### Error Handling

Use Hono's `HTTPException` for expected errors and a global error handler for unexpected ones:

```typescript
import { HTTPException } from "hono/http-exception";

// In route handlers -- throw typed errors
if (!todo) {
  throw new HTTPException(404, { message: "Todo not found" });
}

// Global error handler in app setup
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});
```

### Context Typing

Type your Hono app with environment bindings:

```typescript
type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  user: { id: string; role: string };
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
```

## Drizzle ORM Patterns

### Schema Design

One file per table in `api/src/db/schema/`. Export all tables from an `index.ts` barrel:

```typescript
// api/src/db/schema/todos.ts
import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const todos = pgTable("todos", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  completed: boolean("completed").notNull().default(false),
  userId: uuid("user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

### Relations

Define relations explicitly for type-safe joins:

```typescript
import { relations } from "drizzle-orm";

export const todosRelations = relations(todos, ({ one }) => ({
  user: one(users, {
    fields: [todos.userId],
    references: [users.id],
  }),
}));
```

### Queries

Use the query builder for reads, insert/update/delete for writes:

```typescript
// Read with relations
const todosWithUser = await db.query.todos.findMany({
  where: eq(todos.completed, false),
  with: { user: true },
  limit: 20,
  offset: 0,
});

// Insert
const [newTodo] = await db.insert(todos).values(input).returning();

// Update
const [updated] = await db
  .update(todos)
  .set({ completed: true, updatedAt: new Date() })
  .where(eq(todos.id, id))
  .returning();
```

### Transactions

Wrap multi-table writes in transactions:

```typescript
const result = await db.transaction(async (tx) => {
  const [todo] = await tx.insert(todos).values(input).returning();
  await tx.insert(activityLog).values({
    action: "todo.created",
    resourceId: todo.id,
  });
  return todo;
});
```

## Testing Strategy

### Unit Tests (Services)

Test business logic in isolation with mocked database:

```typescript
// api/tests/unit/todo-service.test.ts
describe("TodoService", () => {
  it("should reject empty titles", () => {
    expect(() => todoService.validate({ title: "" })).toThrow();
  });
});
```

### Integration Tests (Routes)

Test the full request/response cycle with a real test database:

```typescript
// api/tests/integration/todos.test.ts
import { app } from "../../src/app";

describe("POST /api/v1/todos", () => {
  it("should create a todo and return 201", async () => {
    const res = await app.request("/api/v1/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test todo" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("Test todo");
    expect(body.id).toBeDefined();
  });
});
```

### Contract Tests

Validate responses match the OpenAPI spec:

```typescript
import { validateResponse } from "../helpers/contract";

it("GET /todos response matches OpenAPI schema", async () => {
  const res = await app.request("/api/v1/todos");
  await validateResponse(res, "get", "/todos", 200);
});
```

### Load Tests

k6 scripts in `api/tests/load/`:

```javascript
import http from "k6/http";
import { check } from "k6";

export const options = { vus: 50, duration: "30s" };

export default function () {
  const res = http.get("http://localhost:8787/api/v1/todos");
  check(res, { "status is 200": (r) => r.status === 200 });
}
```

## Security Standards

### Input Validation

Every route that accepts input must validate with Zod before processing. Never trust client data.

### Authentication Patterns

- **JWT** -- Stateless, preferred for Cloudflare Workers (no session storage needed)
- **API Keys** -- For service-to-service communication, stored hashed in database
- **OAuth2** -- For third-party integrations, delegate to provider

### Rate Limiting

Apply rate limits per route group:

```typescript
import { rateLimiter } from "../middleware/rate-limit";

app.use("/api/v1/*", rateLimiter({ max: 100, window: "1m" }));
app.use("/api/v1/auth/*", rateLimiter({ max: 10, window: "1m" }));
```

### CORS

Configure CORS explicitly -- never leave `origin: *` in production:

```typescript
import { cors } from "hono/cors";

app.use("*", cors({
  origin: ["https://app.example.com"],
  allowMethods: ["GET", "POST", "PUT", "DELETE"],
  allowHeaders: ["Content-Type", "Authorization"],
}));
```

## Error Handling

### Consistent Response Format

All error responses follow the same shape:

```json
{
  "error": "Validation failed",
  "code": "VALIDATION_ERROR",
  "details": [
    { "field": "title", "message": "Required" }
  ]
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Request body or params failed validation |
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `FORBIDDEN` | 403 | Authenticated but insufficient permissions |
| `NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | Duplicate resource or state conflict |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

## Performance

### Query Optimization

- Always select only needed columns: `.select({ id: todos.id, title: todos.title })`
- Use pagination with `limit` and `offset` or cursor-based pagination for large datasets
- Add indexes for columns used in `WHERE`, `ORDER BY`, and `JOIN` clauses

### Caching

Use `Cache-Control` headers for GET endpoints. On Cloudflare Workers, leverage the Cache API:

```typescript
c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
```

### Connection Pooling

For Node.js deployments, configure connection pooling in the Drizzle client:

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 20 });
const db = drizzle(pool);
```

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Route paths | kebab-case | `/api/v1/user-profiles` |
| File names | kebab-case | `user-profile.ts` |
| Schema/table names (TS) | camelCase variable, PascalCase type | `userProfiles`, `UserProfile` |
| Database columns | snake_case | `created_at`, `user_id` |
| Environment variables | SCREAMING_SNAKE | `DATABASE_URL`, `JWT_SECRET` |
| Zod schemas | camelCase with `Schema` suffix | `createTodoSchema` |
| Service classes | PascalCase with `Service` suffix | `TodoService` |
| Test files | Same as source with `.test.ts` | `todos.test.ts` |
