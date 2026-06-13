# Aurelius → Nerva: Full-Stack Workflow

Generate a matching backend from an Aurelius frontend with one command. `/build-from-aurelius` reads the frontend's `build-spec.json`, works out the API that frontend needs, generates an OpenAPI spec, runs the standard [10-phase build](./README.md), and produces a typed client the frontend imports directly.

[Aurelius](https://github.com/PMDevSolutions/Aurelius) builds the frontend and records, in a `build-spec.json`, what every screen renders and which data it needs. Nerva treats that file as a contract: each list view implies a collection endpoint, each form implies a write endpoint and its validation, each login screen implies an auth flow. Instead of hand-writing an OpenAPI spec to match a frontend you already built, you derive it. Frontend and backend then share one source of truth and one set of generated types.

This guide walks the whole path with a single example -- a small storefront -- carried from its Aurelius `build-spec.json` through the generated OpenAPI spec to the typed client the frontend calls.

## The Data Flow

```
  AURELIUS (frontend)                      NERVA (backend)
  ───────────────────                      ───────────────

  Figma / Canva design
          │
          ▼
  /build-from-figma
          │
          ▼
  build-spec.json  ───────────────▶  /build-from-aurelius
  · pages & routes                            │
  · components & forms                        ▼
  · data bindings              Phase 1  Analyze frontend data needs
  · auth flows                                │
  · design tokens                             ▼
                              Phase 2  Generate OpenAPI 3.1 spec
                                              │
                                              ▼
                              Phase 3  Confirm component → endpoint map
                                              │
                                              ▼
                              Phase 4  Hand off to /build-from-schema
                                              │        → working, tested API
                                              ▼
                                      docs/openapi.yaml
                                              │
                                 ./scripts/generate-client.sh
                                              │
          ┌───────────────────────────────────┘
          ▼
  client/api-types.d.ts
  imported by the frontend   ◀──  one set of types, both sides
```

The arrows run one way: the frontend describes its needs, Nerva builds to them, and the generated client closes the loop so the frontend calls the new API with full type checking.

## How Aurelius Generates `build-spec.json`

`build-spec.json` is an Aurelius artifact. Aurelius's own build commands (`/build-from-figma`, `/build-from-canva`) produce it as they turn a design into a working frontend, recording the structure they generate:

- **Pages and routes** -- every screen and its URL, and whether it is public or behind auth.
- **Components** -- what each one renders, and the forms it contains (fields, types, required flags).
- **Data bindings** -- which data each page loads, its shape (a list or a single item), page sizes for paginated lists, and the fields actually displayed.
- **Auth flows** -- login, registration, and protected routes.
- **Design tokens** -- colors, spacing, typography.

Nerva reads this file and never writes to it. Point the command at the path, or let it search the default locations (`.claude/plans/build-spec.json`, `../aurelius/.claude/plans/build-spec.json`, `../frontend/.claude/plans/build-spec.json`):

```
/build-from-aurelius ../storefront/.claude/plans/build-spec.json
```

> **Two files share the name.** This `build-spec.json` is Aurelius's *frontend* spec and is the input here. Nerva's own pipeline later writes a different `.claude/plans/build-spec.json` -- its internal build plan, parsed from the OpenAPI spec in Phase 0 of [`/build-from-schema`](./README.md). They are not the same file; one describes a UI, the other an API.

A storefront's frontend spec, trimmed to the parts Nerva reads:

```json
{
  "framework": "react",
  "name": "storefront",
  "auth": { "strategy": "jwt", "flows": ["login"] },
  "designTokens": {
    "colors": { "primary": "#4f46e5", "surface": "#ffffff" },
    "radius": { "md": "8px" }
  },
  "pages": [
    {
      "route": "/login",
      "component": "LoginPage",
      "access": "public",
      "children": ["LoginForm"]
    },
    {
      "route": "/products",
      "component": "ProductsPage",
      "access": "public",
      "data": [
        {
          "source": "products",
          "shape": "list",
          "pagination": { "pageSize": 12 },
          "fields": ["id", "name", "price", "imageUrl"]
        }
      ],
      "children": ["ProductGrid", "ProductCard"]
    },
    {
      "route": "/products/:id",
      "component": "ProductDetailPage",
      "access": "public",
      "data": [
        {
          "source": "products",
          "shape": "item",
          "key": "id",
          "fields": ["id", "name", "price", "description", "imageUrl", "stock"]
        }
      ]
    },
    {
      "route": "/cart",
      "component": "CartPage",
      "access": "protected",
      "data": [{ "source": "cart", "shape": "item", "fields": ["id", "items", "subtotal"] }],
      "children": ["CartSummary", "AddToCartButton"]
    }
  ],
  "components": {
    "LoginForm": {
      "type": "form",
      "submitsTo": "auth.login",
      "fields": [
        { "name": "email", "type": "email", "required": true },
        { "name": "password", "type": "password", "required": true }
      ]
    },
    "AddToCartButton": {
      "type": "action",
      "triggers": "cart.addItem",
      "payload": [
        { "name": "productId", "type": "uuid", "required": true },
        { "name": "quantity", "type": "integer", "required": true, "min": 1 }
      ]
    }
  }
}
```

## What Nerva Extracts

Phase 1 reads the spec and turns frontend facts into backend requirements. Four passes do the work:

| Pass | Reads | Infers |
|------|-------|--------|
| Component data requirements | Each component's rendered data and forms | The fields an endpoint must return, and the bodies it must accept |
| Page structure | What each page loads on entry vs. on demand, and which mutations it allows | Which endpoints are reads, which are writes, and which list endpoints need pagination |
| Auth flow detection | Login/register forms, `protected` routes, role-specific UI | The auth strategy and which endpoints require credentials |
| Data model inference | Displayed fields, form inputs, nested and linked data | Resource models, their fields and types, relationships, and required constraints |

For the storefront, that produces:

```
Models inferred
───────────────
User      ← auth.flows (login) + LoginForm fields (email, password)
Product   ← products list fields + detail fields (name, price, description, imageUrl, stock)
Cart      ← cart page data (id, subtotal) + protected access (belongs to a user)
CartItem  ← AddToCartButton payload (productId, quantity) + cart "items"

Auth      ← JWT; /login is public, /cart is protected
Pagination ← products list, pageSize 12
Skipped   ← designTokens (frontend-only)
```

A `min: 1` on the add-to-cart quantity becomes a validation constraint; the `protected` flag on `/cart` becomes a JWT requirement on the cart endpoints; the 12-item `pageSize` becomes the default `limit` on the products list.

## How the OpenAPI Spec Is Generated

Phase 2 turns the inferred requirements into an OpenAPI 3.1 spec: auth endpoints for the detected flows, CRUD endpoints for each resource, custom endpoints for non-CRUD actions, and response shapes whose field names match what the components expect. The storefront yields this (abridged to the representative paths):

```yaml
openapi: "3.1.0"
info:
  title: Storefront API
  version: "1.0.0"
paths:
  /auth/login:
    post:
      summary: Authenticate and receive a JWT
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/LoginRequest" }
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/AuthResponse" }
        "401":
          description: Invalid credentials
  /auth/me:
    get:
      summary: Current authenticated user
      security: [{ bearerAuth: [] }]
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/User" }
  /products:
    get:
      summary: List products (paginated)
      parameters:
        - { name: page, in: query, schema: { type: integer, default: 1, minimum: 1 } }
        - { name: limit, in: query, schema: { type: integer, default: 12, maximum: 100 } }
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ProductList" }
  /products/{id}:
    get:
      summary: Get one product
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Product" }
        "404":
          description: Product not found
  /cart:
    get:
      summary: The current user's cart
      security: [{ bearerAuth: [] }]
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Cart" }
  /cart/items:
    post:
      summary: Add an item to the cart
      security: [{ bearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/AddCartItemRequest" }
      responses:
        "201":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Cart" }
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer, bearerFormat: JWT }
  schemas:
    LoginRequest:
      type: object
      required: [email, password]
      properties:
        email: { type: string, format: email }
        password: { type: string, minLength: 8 }
    AuthResponse:
      type: object
      properties:
        token: { type: string }
        user: { $ref: "#/components/schemas/User" }
    User:
      type: object
      properties:
        id: { type: string, format: uuid }
        email: { type: string, format: email }
    Product:
      type: object
      properties:
        id: { type: string, format: uuid }
        name: { type: string }
        price: { type: number }
        description: { type: string }
        imageUrl: { type: string, format: uri }
        stock: { type: integer }
    ProductList:
      type: object
      properties:
        data:
          type: array
          items: { $ref: "#/components/schemas/Product" }
        meta:
          type: object
          properties:
            page: { type: integer }
            limit: { type: integer }
            total: { type: integer }
    CartItem:
      type: object
      properties:
        productId: { type: string, format: uuid }
        quantity: { type: integer, minimum: 1 }
    AddCartItemRequest:
      type: object
      required: [productId, quantity]
      properties:
        productId: { type: string, format: uuid }
        quantity: { type: integer, minimum: 1 }
    Cart:
      type: object
      properties:
        id: { type: string, format: uuid }
        items:
          type: array
          items: { $ref: "#/components/schemas/CartItem" }
        subtotal: { type: number }
```

Each piece traces back to the frontend: `bearerAuth` to the JWT login flow, the `page`/`limit` parameters to the paginated grid, `ProductList.meta` to the pagination component, and `AddCartItemRequest`'s `minimum: 1` to the button's payload constraint.

## Confirming the Mapping

Phase 3 stops before building and shows how each component maps to an endpoint, so you can correct a wrong inference before any code is generated:

```
Frontend → Backend Mapping
━━━━━━━━━━━━━━━━━━━━━━━━━━━

Aurelius Component        → API Endpoint
──────────────────────────────────────────────
LoginForm                 → POST /auth/login
(protected pages)         → GET  /auth/me          (JWT verify)
ProductGrid (paginated)   → GET  /products?page=1&limit=12
ProductCard / Detail      → GET  /products/{id}
CartPage / CartSummary    → GET  /cart             (protected)
AddToCartButton           → POST /cart/items       (protected)

Inferred models: User, Product, Cart, CartItem
Auth strategy:   JWT (login form detected)
Deployment:      [asks you]

Proceed with building the backend API?
```

If a screen reads data the backend should not own -- a value held only in frontend state, say -- this is where you flag it. Confirm, and the build proceeds.

## Handoff to `/build-from-schema`

Phase 4 writes the spec to `api/openapi.yaml` and invokes [`/build-from-schema`](./README.md), the same 10-phase pipeline you would run against a hand-written spec. From here the Aurelius origin no longer matters -- the spec is the contract. Those phases generate the Drizzle schema and migration, write failing integration tests for every endpoint (the hard TDD gate), implement the Hono routes until the tests pass, wire JWT auth and the `protected` requirements onto the cart endpoints, run contract tests against the spec, and emit deployment config for your target. The [pipeline guide](./README.md) documents each phase.

The result is a working, tested API whose responses match the spec the frontend's needs produced.

## Bridging Both Sides: the Typed API Client

A matching backend is only half the value; the other half is calling it without re-describing every type by hand. [`./scripts/generate-client.sh`](../../scripts/generate-client.sh) reads the OpenAPI spec and generates a TypeScript client the frontend imports:

```bash
./scripts/generate-client.sh --spec docs/openapi.yaml --output client/ --runtime
```

It produces, in `client/`:

- `api-types.d.ts` -- every path, parameter, request body, and response as a TypeScript type, generated by `openapi-typescript`.
- `index.ts` -- re-exports the `paths`, `components`, and `operations` types.
- `client.ts` -- with `--runtime`, a fetch client built on `openapi-fetch`, including a `createApiClient({ baseUrl, token })` helper for authenticated calls. Omit `--runtime` for types only.

The Aurelius frontend imports it and calls the API with full inference -- paths, query parameters, and response shapes are all checked at compile time:

```typescript
import { createApiClient } from "../client";

const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL,
  token: session.token,
});

// `page`/`limit` are known query params; `data` is typed as ProductList
const { data, error } = await api.GET("/products", {
  params: { query: { page: 1, limit: 12 } },
});
```

This is what makes the loop worth closing. Add a field to the spec, or rename one, and regenerating the client turns every place the frontend drifts from the backend into a compile error instead of a runtime surprise. For types shared by both sides beyond the wire format, the pipeline also writes `api/src/types/shared.ts`, which you can symlink or publish as a package for the frontend to consume.

Regenerate the client whenever the API changes -- after any rebuild, or in CI on a spec change -- so the frontend's types never lag the backend.

## Frontend-Only Data

Not everything in `build-spec.json` describes the backend. Design tokens -- colors, spacing, typography -- are recorded for the frontend and skipped here; they generate no endpoints, tables, or types. The same holds for any data a component derives or holds purely in client state. When the analysis cannot tell whether a value is server-provided or client-only, Phase 3 asks rather than guessing.

## Troubleshooting

| Situation | What happens | What to do |
|-----------|--------------|------------|
| No `build-spec.json` found | The command searches the default locations, then asks | Pass the path explicitly, or run `/build-from-conversation` to build a spec by interview |
| Spec has no data components | No endpoints can be inferred | Confirm the frontend actually consumes server data; otherwise there is no backend to generate |
| A value is ambiguous | Phase 3 asks whether it is server-provided or client-only | Answer so the model includes or excludes it |
| Complex relationships | Nerva shows the inferred ERD before building | Confirm or correct the relationships, then proceed |

## See Also

- [Schema-to-API Pipeline](./README.md) -- the 10 phases `/build-from-aurelius` hands off to
- [`/build-from-aurelius` command](../../.claude/commands/build-from-aurelius.md) -- the full command definition
- [Architecture overview](../onboarding/architecture.md) -- where this pipeline sits in the framework
- [Aurelius](https://github.com/PMDevSolutions/Aurelius) -- the frontend framework that produces `build-spec.json`
- `/build-from-conversation` -- when there is no frontend yet: generate the spec by interview, then run the same pipeline
