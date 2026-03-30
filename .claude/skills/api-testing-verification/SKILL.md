---
name: api-testing-verification
description: >
  Runs integration tests, contract tests against the OpenAPI spec, and load tests
  using k6. Validates that the API implementation matches the specification, meets
  performance requirements, and handles concurrent load. Produces a comprehensive
  test report. Keywords: testing, integration, contract, load, k6, vitest, coverage,
  performance, verification, validation, spec-compliance, stress-test, benchmark,
  regression, e2e
---

# API Testing and Verification (Phase 4)

## Purpose

Phase 4 runs three layers of testing to verify the API implementation is correct,
spec-compliant, and performant. Integration tests validate behaviour, contract
tests verify OpenAPI spec conformance, and load tests check performance under
concurrent usage. A unified test report is produced at the end.

## When to Use

- Phase 3 (route-generation) is complete and all unit/integration tests pass.
- The user says "verify", "run tests", "check compliance", "load test", or "contract test".
- Before deployment or after significant changes.

## Inputs

| Input | Required | Description |
|---|---|---|
| Passing integration tests | Yes | From Phase 2/3 |
| OpenAPI spec | Yes | `.claude/plans/openapi.yaml` or generated from app |
| Running API instance | For load tests | Local dev server at `http://localhost:8787` |

## Steps

### Step 1 -- Integration Tests with Coverage

Run the full Vitest suite with coverage reporting:

```bash
cd api && pnpm vitest run --coverage --reporter=verbose
```

Coverage thresholds are enforced in vitest.config.ts:

```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'json', 'html', 'lcov'],
  include: ['src/**/*.ts'],
  exclude: ['src/db/migrations/**', 'src/**/*.d.ts'],
  thresholds: {
    statements: 80,
    branches: 75,
    functions: 80,
    lines: 80,
  },
},
```

After running, check the coverage report:

```bash
# Open HTML coverage report
open api/coverage/index.html

# Check JSON coverage for CI
cat api/coverage/coverage-summary.json | jq '.total'
```

### Step 2 -- Contract Tests (OpenAPI Spec Compliance)

Contract tests validate that every response from the API matches the OpenAPI
specification. This catches schema drift between the spec and the implementation.

Install contract testing dependencies:

```bash
cd api && pnpm add -D openapi-response-validator @apidevtools/swagger-parser
```

Create the contract test framework:

```typescript
// api/tests/contract/contract-validator.ts
import SwaggerParser from '@apidevtools/swagger-parser';
import OpenAPIResponseValidator from 'openapi-response-validator';

export class ContractValidator {
  private spec: any;
  private validators: Map<string, OpenAPIResponseValidator> = new Map();

  async load(specPath: string) {
    this.spec = await SwaggerParser.dereference(specPath);
  }

  validateResponse(
    method: string,
    path: string,
    statusCode: number,
    body: unknown,
  ) {
    const pathSpec = this.spec.paths?.[path];
    if (!pathSpec) {
      throw new Error(`Path ${path} not found in OpenAPI spec`);
    }

    const operationSpec = pathSpec[method.toLowerCase()];
    if (!operationSpec) {
      throw new Error(`Method ${method} not found for path ${path}`);
    }

    const key = `${method}:${path}:${statusCode}`;
    if (!this.validators.has(key)) {
      this.validators.set(
        key,
        new OpenAPIResponseValidator({
          responses: operationSpec.responses,
          definitions: this.spec.components?.schemas,
        }),
      );
    }

    const validator = this.validators.get(key)!;
    const errors = validator.validateResponse(statusCode, body);

    if (errors) {
      throw new Error(
        `Contract violation for ${method} ${path} (${statusCode}):\n` +
          JSON.stringify(errors, null, 2),
      );
    }
  }
}
```

Write contract tests for each endpoint:

```typescript
// api/tests/contract/books.contract.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ContractValidator } from './contract-validator';
import { getTestApp } from '../helpers/app';
import {
  createTestBook,
  createTestAdmin,
  generateTestToken,
  authHeader,
} from '../helpers';

describe('Books API Contract Tests', () => {
  let validator: ContractValidator;
  let app: ReturnType<typeof getTestApp>;

  beforeAll(async () => {
    validator = new ContractValidator();
    await validator.load('./.claude/plans/openapi.yaml');
  });

  beforeEach(() => {
    app = getTestApp();
  });

  it('GET /books response matches OpenAPI spec', async () => {
    await createTestBook();
    const res = await app.request('/books');
    const body = await res.json();

    expect(() =>
      validator.validateResponse('GET', '/books', 200, body),
    ).not.toThrow();
  });

  it('GET /books/:id response matches OpenAPI spec', async () => {
    const book = await createTestBook();
    const res = await app.request(`/books/${book.id}`);
    const body = await res.json();

    expect(() =>
      validator.validateResponse('GET', '/books/{id}', 200, body),
    ).not.toThrow();
  });

  it('POST /books 201 response matches OpenAPI spec', async () => {
    const admin = await createTestAdmin();
    const token = await generateTestToken(admin.id, 'admin');

    const res = await app.request('/books', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(token),
      },
      body: JSON.stringify({
        title: 'Contract Test Book',
        author: 'Author',
        isbn: '9780000000099',
        price: '19.99',
      }),
    });
    const body = await res.json();

    expect(() =>
      validator.validateResponse('POST', '/books', 201, body),
    ).not.toThrow();
  });

  it('POST /books 400 error response matches OpenAPI spec', async () => {
    const admin = await createTestAdmin();
    const token = await generateTestToken(admin.id, 'admin');

    const res = await app.request('/books', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(token),
      },
      body: JSON.stringify({}),
    });
    const body = await res.json();

    expect(() =>
      validator.validateResponse('POST', '/books', 400, body),
    ).not.toThrow();
  });
});
```

Run contract tests:

```bash
cd api && pnpm vitest run tests/contract/ --reporter=verbose
```

### Step 3 -- Load Tests with k6

Create the k6 load test script:

```javascript
// api/tests/load/k6-load-test.js
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const listBooksTrend = new Trend('list_books_duration');
const getBookTrend = new Trend('get_book_duration');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8787';
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || '';

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 50 },
    { duration: '2m', target: 100 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    errors: ['rate<0.01'],
    list_books_duration: ['p(95)<300'],
    get_book_duration: ['p(95)<200'],
  },
};

export default function () {
  const headers = { 'Content-Type': 'application/json' };

  group('Public Endpoints', () => {
    // List books
    const listRes = http.get(`${BASE_URL}/books?page=1&limit=20`, { headers });
    listBooksTrend.add(listRes.timings.duration);
    check(listRes, {
      'list books status 200': (r) => r.status === 200,
      'list books has data': (r) => JSON.parse(r.body).data !== undefined,
    });
    errorRate.add(listRes.status !== 200);

    sleep(0.5);

    // Get single book
    const books = JSON.parse(listRes.body).data;
    if (books.length > 0) {
      const bookId = books[Math.floor(Math.random() * books.length)].id;
      const getRes = http.get(`${BASE_URL}/books/${bookId}`, { headers });
      getBookTrend.add(getRes.timings.duration);
      check(getRes, {
        'get book status 200': (r) => r.status === 200,
      });
      errorRate.add(getRes.status !== 200);
    }

    sleep(0.5);

    // Health check
    const healthRes = http.get(`${BASE_URL}/health`, { headers });
    check(healthRes, {
      'health check status 200': (r) => r.status === 200,
    });
  });

  group('Auth Endpoints', () => {
    const loginRes = http.post(
      `${BASE_URL}/auth/login`,
      JSON.stringify({
        email: `loadtest-${__VU}@example.com`,
        password: 'loadtestpassword123',
      }),
      { headers },
    );
    check(loginRes, {
      'login responds': (r) => r.status === 200 || r.status === 401,
    });
    sleep(0.5);
  });
}
```

Run load tests:

```bash
# Start the API server first
cd api && pnpm dev &

# Run k6 load test
k6 run api/tests/load/k6-load-test.js \
  -e BASE_URL=http://localhost:8787 \
  -e ADMIN_TOKEN="your-admin-jwt-here"
```

### Step 4 -- Generate Unified Test Report

```typescript
// scripts/generate-test-report.ts
interface TestReport {
  generatedAt: string;
  integration: {
    passed: number;
    failed: number;
    skipped: number;
    coverage: {
      statements: number;
      branches: number;
      functions: number;
      lines: number;
    };
  };
  contract: {
    passed: number;
    failed: number;
    violations: string[];
  };
  load: {
    totalRequests: number;
    avgResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    errorRate: number;
    maxVUs: number;
    duration: string;
  };
  verdict: 'PASS' | 'FAIL';
  failures: string[];
}

function generateReport(
  integrationResults: any,
  contractResults: any,
  loadResults: any,
): TestReport {
  const failures: string[] = [];

  if (integrationResults.numFailedTests > 0) {
    failures.push(
      `${integrationResults.numFailedTests} integration tests failed`,
    );
  }

  const coverage = integrationResults.coverage;
  if (coverage.statements < 80)
    failures.push(`Statement coverage ${coverage.statements}% < 80%`);
  if (coverage.branches < 75)
    failures.push(`Branch coverage ${coverage.branches}% < 75%`);

  if (contractResults.numFailedTests > 0) {
    failures.push(
      `${contractResults.numFailedTests} contract tests failed`,
    );
  }

  if (loadResults.metrics.http_req_duration.p95 > 500) {
    failures.push(
      `p95 response time ${loadResults.metrics.http_req_duration.p95}ms > 500ms`,
    );
  }
  if (loadResults.metrics.errors.rate > 0.01) {
    failures.push(
      `Error rate ${(loadResults.metrics.errors.rate * 100).toFixed(2)}% > 1%`,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    integration: {
      passed: integrationResults.numPassedTests,
      failed: integrationResults.numFailedTests,
      skipped: integrationResults.numPendingTests,
      coverage,
    },
    contract: {
      passed: contractResults.numPassedTests,
      failed: contractResults.numFailedTests,
      violations: contractResults.violations ?? [],
    },
    load: {
      totalRequests: loadResults.metrics.http_reqs.count,
      avgResponseTime: loadResults.metrics.http_req_duration.avg,
      p95ResponseTime: loadResults.metrics.http_req_duration.p95,
      p99ResponseTime: loadResults.metrics.http_req_duration.p99,
      errorRate: loadResults.metrics.errors.rate,
      maxVUs: loadResults.maxVUs,
      duration: loadResults.duration,
    },
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
    failures,
  };
}
```

### Step 5 -- Run All Layers

```bash
# 1. Integration tests
cd api && pnpm vitest run --coverage --reporter=json --outputFile=test-results.json

# 2. Contract tests
cd api && pnpm vitest run tests/contract/ --reporter=json --outputFile=contract-results.json

# 3. Load tests (requires running server)
k6 run api/tests/load/k6-load-test.js --out json=api/tests/load/results.json

# 4. Generate report
cd api && pnpm tsx ../scripts/generate-test-report.ts
```

## Output

| Artifact | Location | Description |
|---|---|---|
| Integration results | `api/test-results.json` | Vitest JSON report |
| Coverage report | `api/coverage/` | HTML and JSON coverage |
| Contract results | `api/contract-results.json` | Contract test report |
| Load test results | `api/tests/load/results.json` | k6 metrics and summary |
| Unified report | `.claude/plans/test-report.json` | Combined pass/fail verdict |

## Integration

| Skill | Relationship |
|---|---|
| `tdd-from-schema` (Phase 2) | Integration tests written in Phase 2, executed here |
| `route-generation` (Phase 3) | Implementations being tested |
| `deployment-config-generator` (Phase 5) | Deployment proceeds only if verdict is PASS |
| `api-documentation` | Contract tests verify spec accuracy for docs |
| `api-performance` | Load test results may trigger performance optimization |

### Gate Rule

Phase 5 (deployment) SHOULD NOT proceed if the test report verdict is FAIL.
Performance issues identified in load tests should trigger the `api-performance`
skill before deployment.
