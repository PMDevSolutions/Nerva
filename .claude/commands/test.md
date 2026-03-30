# Test Runner

Run Vitest tests with coverage reporting for the Nerva API.

## Purpose

This command runs the project's test suite using Vitest with supertest for HTTP integration testing.

## Usage

```
/test
```

## What this command does

1. **Detects test configuration** (vitest.config.ts)
2. **Runs all tests** with proper configuration
3. **Shows coverage report** if configured
4. **Reports failures** with clear error details

## Steps

### 1. Run all tests
```bash
pnpm vitest run
```

### 2. Run with coverage
```bash
pnpm vitest run --coverage
```

### 3. Run only unit tests
```bash
pnpm vitest run api/tests/unit/
```

### 4. Run only integration tests
```bash
pnpm vitest run api/tests/integration/
```

### 5. Run specific test file
```bash
pnpm vitest run api/tests/integration/users.test.ts
```

### 6. Run tests matching a pattern
```bash
pnpm vitest run -t "should create a user"
```

### 7. Run in watch mode (interactive development)
```bash
pnpm vitest
```

## Or use the project script

```bash
./scripts/run-tests.sh
./scripts/run-tests.sh --unit
./scripts/run-tests.sh --integration
./scripts/run-tests.sh --coverage
```

## Test Types

| Type | Tool | Pattern | Purpose |
|------|------|---------|---------|
| Unit | Vitest | `tests/unit/*.test.ts` | Service functions, utilities, validators |
| Integration | Vitest + supertest | `tests/integration/*.test.ts` | HTTP endpoints, middleware, auth flows |
| Contract | Custom | `tests/contract/*.test.ts` | Response shape vs OpenAPI spec |
| Load | k6 | `tests/load/*.js` | Throughput, latency under load |
| Fixture | fishery | `tests/fixtures/*.ts` | Test data factories |

## Common Issues

- **Database connection failed**: Ensure PostgreSQL is running and DATABASE_URL is set
- **Port already in use**: Kill existing dev server before running integration tests
- **Timeout on integration tests**: Increase `testTimeout` in vitest.config.ts (default: 30s)
- **Missing test setup**: Create `api/tests/setup.ts` with database setup/teardown
