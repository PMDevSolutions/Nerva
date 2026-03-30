---
allowed-tools: Skill, Agent, Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# /build-from-aurelius — Backend for Your Frontend

You are an expert at analyzing frontend applications built with the Aurelius framework and generating the matching backend API. You take an Aurelius `build-spec.json` and produce a complete backend that serves every data need the frontend has.

## Input

The user provides: `$ARGUMENTS` (path to an Aurelius build-spec.json file)

If no path provided, search for `build-spec.json` in common locations:
- `.claude/plans/build-spec.json`
- `../aurelius/.claude/plans/build-spec.json`
- `../frontend/.claude/plans/build-spec.json`

If not found, ask the user for the path.

## Process Overview

```
Read Aurelius build-spec.json → Analyze frontend data needs → Generate OpenAPI spec → /build-from-schema
```

## Phase 1: Analyze Aurelius Build Spec

Read and analyze the Aurelius build-spec.json to extract:

### 1. Component Data Requirements
For each component in the build spec:
- What data does it display? (text content, lists, images, user data)
- What forms does it contain? (input fields, validation rules, submission targets)
- What user interactions trigger API calls? (button clicks, form submissions, pagination)

### 2. Page Structure Analysis
For each page:
- What data must be loaded on page load?
- What data is loaded on demand (infinite scroll, tabs, modals)?
- What mutations can the user perform?

### 3. Auth Flow Detection
From the build spec's component inventory:
- Login/Register forms → auth endpoints needed
- Protected pages → JWT/session middleware needed
- Role-specific UI → RBAC endpoints needed
- OAuth buttons → OAuth2 flow needed

### 4. Data Model Inference
From displayed data and forms, infer:
- Resource models (what entities exist)
- Fields and types (from form inputs and displayed data)
- Relationships (from nested data, linked resources)
- Constraints (required fields from form validation)

## Phase 2: Generate OpenAPI Spec

Transform the analysis into a complete OpenAPI 3.1 specification:

1. **Auth endpoints** — Based on detected auth flows
   - `POST /auth/login` — if login form found
   - `POST /auth/register` — if registration form found
   - `POST /auth/refresh` — if JWT strategy detected
   - `GET /auth/me` — current user profile

2. **CRUD endpoints** — For each inferred resource
   - Standard REST endpoints with proper methods
   - Pagination for list endpoints (matching frontend page sizes)
   - Filtering/sorting based on frontend table/list components

3. **Custom endpoints** — For non-CRUD operations
   - Search endpoints (if search components found)
   - Aggregate endpoints (if dashboard/stats components found)
   - File upload endpoints (if file input components found)
   - Webhook endpoints (if real-time features detected)

4. **Response shapes** — Match what the frontend expects
   - Field names matching component prop expectations
   - Nested data where the frontend shows related resources
   - Pagination metadata matching frontend pagination components

## Phase 3: User Confirmation

Present the generated spec with a mapping table:

```
Frontend → Backend Mapping:
━━━━━━━━━━━━━━━━━━━━━━━━━━━

Aurelius Component          → API Endpoint
─────────────────────────────────────────
LoginForm                   → POST /auth/login
RegisterForm                → POST /auth/register
UserProfile                 → GET /auth/me
ProductGrid (paginated)     → GET /products?page=1&limit=12
ProductDetail               → GET /products/:id
CartSummary                 → GET /cart
AddToCartButton             → POST /cart/items
CheckoutForm                → POST /orders

Inferred Models: User, Product, Cart, CartItem, Order, OrderItem
Auth Strategy: JWT (login form detected)
Deployment: [ask user]

Proceed with building the backend API?
```

## Phase 4: Build

If confirmed, write the OpenAPI spec to `api/openapi.yaml` and invoke `/build-from-schema api/openapi.yaml`.

## Special Handling

### Design Token Integration
If the Aurelius build spec includes design tokens, note them but don't generate backend code for them — they're frontend-only.

### API Client Generation
After the backend is built, automatically run `./scripts/generate-client.sh` to produce a typed TypeScript API client that the Aurelius frontend can import directly.

### Shared Types
Generate shared TypeScript types that can be used by both the frontend and backend:
- Write to `api/src/types/shared.ts`
- Suggest the user symlink or publish as a package for the frontend

## Error Handling

- **No build-spec.json found:** Ask user for path or offer /build-from-conversation
- **Build spec has no data components:** Warn that no API endpoints were inferred, offer /build-from-conversation
- **Ambiguous data needs:** Ask user to clarify which data is server-provided vs client-only
- **Complex relationships:** Show inferred ERD and ask user to confirm before proceeding
