---
name: schema-intake
description: >
  Parses OpenAPI 3.x specifications (YAML or JSON) or conducts a structured interview
  to generate one from scratch. Produces a canonical build-spec.json that drives all
  downstream pipeline phases. Use this skill at the very start of any new API project,
  when the user supplies an OpenAPI file, or when they want to describe an API
  conversationally. Keywords: openapi, swagger, spec, schema, intake, interview,
  build-spec, api-design, yaml, json, parse, plan, kickoff, init, bootstrap
---

# Schema Intake (Phase 0)

## Purpose

Schema Intake is the entry point to the Nerva pipeline. It accepts an OpenAPI 3.x
specification in YAML or JSON format, validates it, and distills it into a
normalised `build-spec.json` file that every subsequent phase consumes. When no
specification exists, the skill switches to an interactive interview mode, asks
5-7 targeted questions, and generates both the OpenAPI document and the
build-spec from the answers.

## When to Use

- The user provides an OpenAPI spec file and wants to start a new API project.
- The user wants to describe an API in plain language and have a spec generated.
- A new Nerva pipeline build is starting and Phase 0 has not been completed.
- The user says "new api", "start project", "parse my spec", or "build from spec".

## Inputs

| Input | Required | Description |
|---|---|---|
| OpenAPI file path | No | Path to a `.yaml`, `.yml`, or `.json` OpenAPI 3.x file |
| Conversational answers | No | Answers to the structured interview (if no file) |

At least one of the above must be provided.

## Steps

### Step 1 -- Detect Input Type

Determine whether the user has provided a file or wants the interview flow.

```typescript
// Pseudo-logic
if (userProvidedFile) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.yaml', '.yml'].includes(ext)) {
    spec = yaml.parse(await readFile(filePath, 'utf-8'));
  } else if (ext === '.json') {
    spec = JSON.parse(await readFile(filePath, 'utf-8'));
  } else {
    throw new Error('Unsupported file format. Provide .yaml, .yml, or .json');
  }
} else {
  // Interview flow -- proceed to Step 2a
}
```

### Step 2a -- Interview Flow (No Spec Provided)

Ask the following questions in order. Wait for the answer to each before
continuing. Adapt follow-up questions based on responses.

**Question 1 -- Purpose**
> What does this API do? Describe its core purpose in 1-2 sentences.

**Question 2 -- Resources**
> What are the main resources (nouns) this API manages?
> Example: users, products, orders, reviews

**Question 3 -- Relationships**
> What relationships exist between those resources?
> Example: "A user has many orders", "An order has many line items"

**Question 4 -- Operations**
> For each resource, which operations are needed?
> Default assumption: full CRUD unless the user restricts it.

**Question 5 -- Authentication**
> What authentication strategy should the API use?
> Options: JWT (default), API key, OAuth2, none

**Question 6 -- Deployment Target**
> Where will this API be deployed?
> Options: Cloudflare Workers (default), Node.js / Docker

**Question 7 -- Additional Requirements** (optional)
> Any special requirements? (pagination style, rate limiting, soft deletes, etc.)

After gathering answers, generate the OpenAPI 3.1 spec:

```typescript
function generateOpenAPIFromInterview(answers: InterviewAnswers): OpenAPISpec {
  const spec: OpenAPISpec = {
    openapi: '3.1.0',
    info: {
      title: answers.purpose.extractTitle(),
      description: answers.purpose.full,
      version: '1.0.0',
    },
    servers: [
      { url: 'http://localhost:8787', description: 'Local development' },
    ],
    paths: {},
    components: {
      schemas: {},
      securitySchemes: {},
    },
  };

  // Generate schemas from resources
  for (const resource of answers.resources) {
    const schemaName = pascalCase(resource.name);
    spec.components.schemas[schemaName] = {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        ...resource.fields.reduce((acc, field) => ({
          ...acc,
          [field.name]: mapFieldToOpenAPI(field),
        }), {}),
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
      required: ['id', ...resource.requiredFields],
    };
  }

  // Generate paths for each resource
  for (const resource of answers.resources) {
    const basePath = `/${kebabCase(resource.name)}`;
    const tag = pascalCase(resource.name);

    if (resource.operations.includes('list')) {
      spec.paths[basePath] = {
        ...spec.paths[basePath],
        get: {
          tags: [tag],
          summary: `List ${resource.name}`,
          operationId: `list${pascalCase(resource.name)}`,
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          ],
          responses: {
            '200': {
              description: 'Successful response',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: {
                        type: 'array',
                        items: { $ref: `#/components/schemas/${pascalCase(resource.name)}` },
                      },
                      meta: { $ref: '#/components/schemas/PaginationMeta' },
                    },
                  },
                },
              },
            },
          },
        },
      };
    }

    if (resource.operations.includes('create')) {
      spec.paths[basePath] = {
        ...spec.paths[basePath],
        post: {
          tags: [tag],
          summary: `Create ${singularize(resource.name)}`,
          operationId: `create${pascalCase(singularize(resource.name))}`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  $ref: `#/components/schemas/Create${pascalCase(singularize(resource.name))}`,
                },
              },
            },
          },
          responses: {
            '201': { description: 'Created' },
            '400': { description: 'Validation error' },
            '401': { description: 'Unauthorized' },
          },
        },
      };
    }

    if (resource.operations.includes('read')) {
      spec.paths[`${basePath}/{id}`] = {
        get: {
          tags: [tag],
          summary: `Get ${singularize(resource.name)} by ID`,
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Successful response' },
            '404': { description: 'Not found' },
          },
        },
      };
    }

    if (resource.operations.includes('update')) {
      spec.paths[`${basePath}/{id}`] = {
        ...spec.paths[`${basePath}/{id}`],
        patch: {
          tags: [tag],
          summary: `Update ${singularize(resource.name)}`,
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Updated' },
            '400': { description: 'Validation error' },
            '404': { description: 'Not found' },
          },
        },
      };
    }

    if (resource.operations.includes('delete')) {
      spec.paths[`${basePath}/{id}`] = {
        ...spec.paths[`${basePath}/{id}`],
        delete: {
          tags: [tag],
          summary: `Delete ${singularize(resource.name)}`,
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '204': { description: 'Deleted' },
            '404': { description: 'Not found' },
          },
        },
      };
    }
  }

  // Add security schemes
  if (answers.auth === 'jwt') {
    spec.components.securitySchemes = {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    };
    spec.security = [{ bearerAuth: [] }];
  } else if (answers.auth === 'apikey') {
    spec.components.securitySchemes = {
      apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    };
    spec.security = [{ apiKeyAuth: [] }];
  }

  return spec;
}
```

### Step 2b -- File-Based Flow (Spec Provided)

Validate the OpenAPI document structure:

```typescript
import SwaggerParser from '@apidevtools/swagger-parser';

async function validateSpec(specPath: string): Promise<OpenAPISpec> {
  try {
    const api = await SwaggerParser.validate(specPath);
    console.log('API name: %s, Version: %s', api.info.title, api.info.version);
    return api as OpenAPISpec;
  } catch (err) {
    throw new Error(`Invalid OpenAPI spec: ${err.message}`);
  }
}
```

### Step 3 -- Extract Canonical Data

Parse the validated spec into structured data for the build-spec:

```typescript
interface BuildSpec {
  meta: {
    title: string;
    version: string;
    description: string;
    generatedAt: string;
    sourceType: 'file' | 'interview';
  };
  deployment: {
    target: 'cloudflare-workers' | 'node';
    runtime: string;
  };
  auth: {
    strategy: 'jwt' | 'apikey' | 'oauth2' | 'none';
    protectedRoutes: string[];
    publicRoutes: string[];
  };
  models: Model[];
  endpoints: Endpoint[];
  relationships: Relationship[];
}

interface Model {
  name: string;
  tableName: string;
  fields: Field[];
  indexes: Index[];
}

interface Field {
  name: string;
  type: string;
  pgType: string;
  required: boolean;
  unique: boolean;
  default?: unknown;
  reference?: { model: string; field: string };
}

interface Endpoint {
  method: string;
  path: string;
  operationId: string;
  tags: string[];
  auth: boolean;
  requestBody?: SchemaRef;
  responseBody: SchemaRef;
  queryParams: Param[];
  pathParams: Param[];
}

interface Relationship {
  type: 'one-to-one' | 'one-to-many' | 'many-to-many';
  from: string;
  to: string;
  foreignKey: string;
  joinTable?: string;
}
```

### Step 4 -- Map OpenAPI Types to PostgreSQL Types

```typescript
const TYPE_MAP: Record<string, string> = {
  'string': 'text',
  'string:uuid': 'uuid',
  'string:email': 'text',
  'string:date-time': 'timestamp',
  'string:date': 'date',
  'string:uri': 'text',
  'string:enum': 'text',
  'integer': 'integer',
  'integer:int64': 'bigint',
  'number': 'numeric',
  'number:double': 'doublePrecision',
  'number:float': 'real',
  'boolean': 'boolean',
  'array': 'jsonb',
  'object': 'jsonb',
};

function mapOpenAPITypeToPg(schema: OpenAPISchema): string {
  const key = schema.format
    ? `${schema.type}:${schema.format}`
    : schema.type;
  return TYPE_MAP[key] ?? 'text';
}
```

### Step 5 -- Detect Relationships

```typescript
function detectRelationships(
  schemas: Record<string, OpenAPISchema>,
): Relationship[] {
  const relationships: Relationship[] = [];

  for (const [name, schema] of Object.entries(schemas)) {
    for (const [fieldName, fieldSchema] of Object.entries(
      schema.properties ?? {},
    )) {
      // Direct foreign key (e.g., userId -> User)
      if (fieldName.endsWith('Id') && fieldSchema.type === 'string') {
        const targetModel = pascalCase(fieldName.replace(/Id$/, ''));
        if (schemas[targetModel]) {
          relationships.push({
            type: 'one-to-many',
            from: targetModel,
            to: name,
            foreignKey: fieldName,
          });
        }
      }

      // Array of $ref (one-to-many reverse)
      if (fieldSchema.type === 'array' && fieldSchema.items?.$ref) {
        const targetModel = fieldSchema.items.$ref.split('/').pop();
        relationships.push({
          type: 'one-to-many',
          from: name,
          to: targetModel,
          foreignKey: `${camelCase(name)}Id`,
        });
      }
    }
  }

  return deduplicateRelationships(relationships);
}
```

### Step 6 -- Generate build-spec.json

Write the file to `.claude/plans/build-spec.json`:

```typescript
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';

async function writeBuildSpec(spec: BuildSpec): Promise<void> {
  const dir = path.join(process.cwd(), '.claude', 'plans');
  await mkdir(dir, { recursive: true });

  const filePath = path.join(dir, 'build-spec.json');
  await writeFile(filePath, JSON.stringify(spec, null, 2), 'utf-8');

  console.log(`Build spec written to ${filePath}`);
  console.log(`  Models: ${spec.models.length}`);
  console.log(`  Endpoints: ${spec.endpoints.length}`);
  console.log(`  Relationships: ${spec.relationships.length}`);
  console.log(`  Auth: ${spec.auth.strategy}`);
  console.log(`  Target: ${spec.deployment.target}`);
}
```

### Step 7 -- Validation Gate

Before finishing, validate the build-spec is internally consistent:

```typescript
function validateBuildSpec(spec: BuildSpec): string[] {
  const errors: string[] = [];

  // Every endpoint referenced model must exist
  for (const endpoint of spec.endpoints) {
    const modelRefs = extractModelRefs(endpoint);
    for (const ref of modelRefs) {
      if (!spec.models.find((m) => m.name === ref)) {
        errors.push(
          `Endpoint ${endpoint.method} ${endpoint.path} references unknown model: ${ref}`,
        );
      }
    }
  }

  // Every relationship must reference valid models
  for (const rel of spec.relationships) {
    if (!spec.models.find((m) => m.name === rel.from)) {
      errors.push(`Relationship references unknown model: ${rel.from}`);
    }
    if (!spec.models.find((m) => m.name === rel.to)) {
      errors.push(`Relationship references unknown model: ${rel.to}`);
    }
  }

  // Every model must have an id field
  for (const model of spec.models) {
    if (!model.fields.find((f) => f.name === 'id')) {
      errors.push(`Model ${model.name} is missing an id field`);
    }
  }

  return errors;
}
```

## Output

| Artifact | Location | Description |
|---|---|---|
| `build-spec.json` | `.claude/plans/build-spec.json` | Canonical project specification |
| OpenAPI spec (if generated) | `.claude/plans/openapi.yaml` | Generated OpenAPI 3.1 document |
| Validation report | Console output | List of any validation warnings |

### build-spec.json Example

```json
{
  "meta": {
    "title": "Bookstore API",
    "version": "1.0.0",
    "description": "API for managing a bookstore inventory and orders",
    "generatedAt": "2026-03-29T12:00:00Z",
    "sourceType": "interview"
  },
  "deployment": {
    "target": "cloudflare-workers",
    "runtime": "workerd"
  },
  "auth": {
    "strategy": "jwt",
    "protectedRoutes": ["/orders", "/orders/*", "/users/me"],
    "publicRoutes": ["/books", "/books/*", "/auth/login", "/auth/register"]
  },
  "models": [
    {
      "name": "User",
      "tableName": "users",
      "fields": [
        { "name": "id", "type": "string", "pgType": "uuid", "required": true, "unique": true },
        { "name": "email", "type": "string", "pgType": "text", "required": true, "unique": true },
        { "name": "passwordHash", "type": "string", "pgType": "text", "required": true, "unique": false },
        { "name": "role", "type": "string", "pgType": "text", "required": true, "unique": false, "default": "customer" }
      ],
      "indexes": [{ "name": "users_email_idx", "columns": ["email"], "unique": true }]
    },
    {
      "name": "Book",
      "tableName": "books",
      "fields": [
        { "name": "id", "type": "string", "pgType": "uuid", "required": true, "unique": true },
        { "name": "title", "type": "string", "pgType": "text", "required": true, "unique": false },
        { "name": "isbn", "type": "string", "pgType": "text", "required": true, "unique": true },
        { "name": "price", "type": "number", "pgType": "numeric", "required": true, "unique": false }
      ],
      "indexes": [{ "name": "books_isbn_idx", "columns": ["isbn"], "unique": true }]
    }
  ],
  "endpoints": [
    { "method": "GET", "path": "/books", "operationId": "listBooks", "tags": ["Books"], "auth": false },
    { "method": "POST", "path": "/books", "operationId": "createBook", "tags": ["Books"], "auth": true }
  ],
  "relationships": [
    { "type": "one-to-many", "from": "User", "to": "Order", "foreignKey": "userId" },
    { "type": "one-to-many", "from": "Order", "to": "OrderItem", "foreignKey": "orderId" },
    { "type": "one-to-many", "from": "Book", "to": "OrderItem", "foreignKey": "bookId" }
  ]
}
```

## Integration

| Downstream Skill | How It Uses build-spec.json |
|---|---|
| `database-design` (Phase 1) | Reads `models` and `relationships` to generate Drizzle schemas |
| `tdd-from-schema` (Phase 2) | Reads `endpoints` and `auth` to generate test cases |
| `route-generation` (Phase 3) | Reads `endpoints` to scaffold Hono route handlers |
| `api-authentication` | Reads `auth` to configure JWT/API key middleware |
| `deployment-config-generator` | Reads `deployment` to generate wrangler.toml or Dockerfile |
| `api-documentation` | Reads the generated OpenAPI spec or regenerates from build-spec |

### Triggering the Next Phase

After generating build-spec.json, prompt the user:

> Build spec generated with {N} models, {M} endpoints, and {R} relationships.
> Ready to proceed to Phase 1 (Database Design). Run the `database-design` skill to continue.
