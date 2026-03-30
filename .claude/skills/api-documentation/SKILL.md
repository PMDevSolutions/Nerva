---
name: api-documentation
description: >
  Generates OpenAPI 3.1 specification from the Hono app and Zod schemas, sets up
  interactive API documentation using Scalar UI, generates Postman collections,
  and creates API quickstart documentation. Uses @hono/zod-openapi for spec
  generation. Keywords: openapi, swagger, documentation, docs, scalar, postman,
  collection, spec, api-reference, interactive, ui, endpoint, schema, quickstart,
  hono-zod-openapi
---

# API Documentation

## Purpose

Generates comprehensive API documentation from the Hono app definition and Zod
schemas. Produces an OpenAPI 3.1 specification, sets up interactive documentation
with Scalar UI, generates Postman collections for API testing, and creates
quickstart guides. Documentation stays in sync with the implementation because
it is generated from the same Zod schemas used for validation.

## When to Use

- The API implementation is complete and documentation is needed.
- The user says "docs", "documentation", "openapi", "swagger", "scalar", or "postman".
- API endpoints have changed and documentation needs updating.
- A Postman collection is needed for manual or automated testing.

## Inputs

| Input | Required | Description |
|---|---|---|
| Hono routes | Yes | `api/src/routes/*.ts` with Zod validators |
| Zod schemas | Yes | `api/src/validators/*.ts` |
| `build-spec.json` | Recommended | For API metadata |

## Steps

### Step 1 -- Install Dependencies

```bash
cd api && pnpm add @hono/zod-openapi @scalar/hono-api-reference
```

### Step 2 -- Convert Routes to OpenAPI-Aware Routes

Replace standard Hono routes with `@hono/zod-openapi` routes for automatic
spec generation:

```typescript
// api/src/routes/books.openapi.ts
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../app';
import {
  insertBookSchema,
  selectBookSchema,
  updateBookSchema,
  listBooksQuerySchema,
} from '../validators/books';
import { uuidParamSchema, errorResponseSchema } from '../validators/shared';

// Define the route with full OpenAPI metadata
const listBooksRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Books'],
  summary: 'List all books',
  description: 'Returns a paginated list of books with optional filtering and sorting.',
  request: {
    query: listBooksQuerySchema,
  },
  responses: {
    200: {
      description: 'Paginated list of books',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(selectBookSchema),
            meta: z.object({
              page: z.number(),
              limit: z.number(),
              total: z.number(),
              totalPages: z.number(),
            }),
          }),
        },
      },
    },
    400: {
      description: 'Invalid query parameters',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const getBookRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Books'],
  summary: 'Get a book by ID',
  request: {
    params: uuidParamSchema,
  },
  responses: {
    200: {
      description: 'Book details',
      content: {
        'application/json': {
          schema: selectBookSchema,
        },
      },
    },
    404: {
      description: 'Book not found',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const createBookRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Books'],
  summary: 'Create a new book',
  description: 'Creates a new book. Requires admin role.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: insertBookSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Book created successfully',
      content: {
        'application/json': {
          schema: selectBookSchema,
        },
      },
    },
    400: {
      description: 'Validation error',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
    409: {
      description: 'Book with this ISBN already exists',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const updateBookRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Books'],
  summary: 'Update a book',
  description: 'Partially update a book by ID. Requires admin role.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uuidParamSchema,
    body: {
      content: {
        'application/json': {
          schema: updateBookSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Book updated successfully',
      content: {
        'application/json': {
          schema: selectBookSchema,
        },
      },
    },
    400: {
      description: 'Validation error',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
    404: {
      description: 'Book not found',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const deleteBookRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Books'],
  summary: 'Delete a book',
  description: 'Delete a book by ID. Requires admin role.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uuidParamSchema,
  },
  responses: {
    204: {
      description: 'Book deleted successfully',
    },
    404: {
      description: 'Book not found',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

// Wire up the OpenAPI routes with handlers
export function booksRoutes() {
  const router = new OpenAPIHono<AppEnv>();

  router.openapi(listBooksRoute, async (c) => {
    const query = c.req.valid('query');
    const service = new BooksService(c.get('db'));
    const result = await service.list(query);
    return c.json(result, 200);
  });

  router.openapi(getBookRoute, async (c) => {
    const { id } = c.req.valid('param');
    const service = new BooksService(c.get('db'));
    const book = await service.getById(id);
    return c.json(book, 200);
  });

  router.openapi(createBookRoute, async (c) => {
    const data = c.req.valid('json');
    const service = new BooksService(c.get('db'));
    const book = await service.create(data);
    return c.json(book, 201);
  });

  router.openapi(updateBookRoute, async (c) => {
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const service = new BooksService(c.get('db'));
    const book = await service.update(id, data);
    return c.json(book, 200);
  });

  router.openapi(deleteBookRoute, async (c) => {
    const { id } = c.req.valid('param');
    const service = new BooksService(c.get('db'));
    await service.delete(id);
    return c.body(null, 204);
  });

  return router;
}
```

### Step 3 -- Generate OpenAPI Spec from App

```typescript
// api/src/openapi.ts
import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from './app';

export function createOpenAPIApp({ db }: { db: Database }) {
  const app = new OpenAPIHono<AppEnv>();

  // Register all route groups
  app.route('/books', booksRoutes());
  app.route('/auth', authRoutes());
  app.route('/orders', ordersRoutes());
  app.route('/users', usersRoutes());

  // Generate the OpenAPI document
  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'My API',
      version: '1.0.0',
      description: 'API documentation generated from Zod schemas',
      contact: {
        name: 'API Support',
        email: 'support@example.com',
      },
    },
    servers: [
      { url: 'http://localhost:8787', description: 'Local development' },
      { url: 'https://api-staging.example.com', description: 'Staging' },
      { url: 'https://api.example.com', description: 'Production' },
    ],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Auth', description: 'Authentication and authorization' },
      { name: 'Books', description: 'Book management' },
      { name: 'Orders', description: 'Order management' },
      { name: 'Users', description: 'User management' },
    ],
  });

  // Register security scheme
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'JWT access token obtained from /auth/login',
  });

  return app;
}
```

### Step 4 -- Set Up Scalar UI

```typescript
// api/src/routes/docs.ts
import { Hono } from 'hono';
import { apiReference } from '@scalar/hono-api-reference';

export function docsRoutes() {
  const router = new Hono();

  // Serve Scalar API reference UI
  router.get(
    '/',
    apiReference({
      spec: {
        url: '/openapi.json',
      },
      theme: 'kepler',
      layout: 'modern',
      defaultHttpClient: {
        targetKey: 'javascript',
        clientKey: 'fetch',
      },
      metaData: {
        title: 'API Documentation',
      },
    }),
  );

  return router;
}
```

Wire it up in the app:

```typescript
// In api/src/app.ts
import { docsRoutes } from './routes/docs';

// Add to app setup
app.route('/docs', docsRoutes());
// GET /docs -- Scalar UI
// GET /openapi.json -- OpenAPI spec
```

Scalar provides:
- Interactive "Try it out" functionality for testing endpoints.
- Authentication token persistence across requests.
- Code examples in multiple languages (cURL, JavaScript, Python, etc.).
- Schema visualization for request and response bodies.
- Search across all endpoints.

### Step 5 -- Generate Postman Collection

```typescript
// scripts/generate-postman-collection.ts
import { readFile, writeFile } from 'fs/promises';

interface PostmanCollection {
  info: { name: string; schema: string };
  item: PostmanFolder[];
  variable: PostmanVariable[];
  auth: any;
}

interface PostmanFolder {
  name: string;
  item: PostmanRequest[];
}

interface PostmanRequest {
  name: string;
  request: {
    method: string;
    header: any[];
    url: { raw: string; host: string[]; path: string[] };
    body?: any;
    auth?: any;
  };
}

interface PostmanVariable {
  key: string;
  value: string;
}

async function generatePostmanCollection(openApiPath: string) {
  const spec = JSON.parse(await readFile(openApiPath, 'utf-8'));

  const collection: PostmanCollection = {
    info: {
      name: spec.info.title,
      schema:
        'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: 'http://localhost:8787' },
      { key: 'token', value: '' },
      { key: 'refreshToken', value: '' },
    ],
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{token}}' }],
    },
    item: [],
  };

  // Group endpoints by tag
  const tagGroups: Record<string, PostmanRequest[]> = {};

  for (const [pathStr, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods as any)) {
      if (method === 'parameters') continue;

      const tag = operation.tags?.[0] ?? 'Default';
      if (!tagGroups[tag]) tagGroups[tag] = [];

      const postmanPath = pathStr.replace(/{(\w+)}/g, ':$1');

      const request: PostmanRequest = {
        name: operation.summary ?? `${method.toUpperCase()} ${pathStr}`,
        request: {
          method: method.toUpperCase(),
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: {
            raw: `{{baseUrl}}${postmanPath}`,
            host: ['{{baseUrl}}'],
            path: postmanPath.split('/').filter(Boolean),
          },
        },
      };

      // Add request body example
      if (operation.requestBody) {
        const schema =
          operation.requestBody.content?.['application/json']?.schema;
        if (schema) {
          request.request.body = {
            mode: 'raw',
            raw: JSON.stringify(generateExample(schema), null, 2),
          };
        }
      }

      tagGroups[tag].push(request);
    }
  }

  // Convert to folders
  for (const [tag, requests] of Object.entries(tagGroups)) {
    collection.item.push({ name: tag, item: requests });
  }

  const outputPath = '.claude/plans/postman-collection.json';
  await writeFile(outputPath, JSON.stringify(collection, null, 2));
  console.log(`Postman collection written to ${outputPath}`);
}

function generateExample(schema: any): any {
  if (schema.example) return schema.example;
  if (schema.type === 'object') {
    const obj: any = {};
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      obj[key] = generateExample(prop);
    }
    return obj;
  }
  if (schema.type === 'string') {
    if (schema.format === 'email') return 'user@example.com';
    if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000001';
    if (schema.format === 'date-time') return new Date().toISOString();
    return 'string';
  }
  if (schema.type === 'integer') return 1;
  if (schema.type === 'number') return 0.0;
  if (schema.type === 'boolean') return true;
  if (schema.type === 'array') return [generateExample(schema.items)];
  return null;
}

generatePostmanCollection('.claude/plans/openapi.json');
```

Run the generator:

```bash
cd api && pnpm tsx ../scripts/generate-postman-collection.ts
```

### Step 6 -- Generate Typed API Client

For TypeScript consumers (frontend apps, other services):

```bash
# Generate TypeScript types from OpenAPI spec
npx openapi-typescript .claude/plans/openapi.json -o api/src/types/api-client.d.ts
```

Usage with openapi-fetch:

```typescript
import createClient from 'openapi-fetch';
import type { paths } from './types/api-client';

const client = createClient<paths>({
  baseUrl: 'https://api.example.com',
});

// Fully typed request and response
const { data, error } = await client.GET('/books', {
  params: { query: { page: 1, limit: 20 } },
});

const { data: book } = await client.GET('/books/{id}', {
  params: { path: { id: 'some-uuid' } },
});

const { data: created } = await client.POST('/books', {
  headers: { Authorization: `Bearer ${token}` },
  body: {
    title: 'New Book',
    author: 'Author Name',
    isbn: '9781234567890',
    price: '29.99',
  },
});
```

### Step 7 -- Export OpenAPI Spec to File

```bash
# Start the dev server and fetch the spec
cd api && pnpm dev &
sleep 2
curl -s http://localhost:8787/openapi.json | jq . > .claude/plans/openapi.json

# Convert to YAML if needed
npx json2yaml .claude/plans/openapi.json > .claude/plans/openapi.yaml
```

## Output

| Artifact | Location | Description |
|---|---|---|
| OpenAPI spec | `/openapi.json` endpoint | Live API specification |
| OpenAPI file | `.claude/plans/openapi.json` | Static spec file |
| Scalar UI | `/docs` endpoint | Interactive API documentation |
| Postman collection | `.claude/plans/postman-collection.json` | Import into Postman |
| TypeScript types | `api/src/types/api-client.d.ts` | Typed client definitions |
| OpenAPI routes | `api/src/routes/*.openapi.ts` | Routes with OpenAPI metadata |

## Integration

| Skill | Relationship |
|---|---|
| `api-validation` | Zod schemas drive both validation and documentation |
| `api-testing-verification` | Contract tests validate against the generated spec |
| `schema-intake` | Generated spec can be round-tripped through schema-intake |
| `route-generation` | OpenAPI routes extend the base Hono routes |
| `deployment-config-generator` | Docs endpoint included in deployment |
