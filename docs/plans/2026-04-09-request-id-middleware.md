# Request ID Middleware Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Hono's built-in `requestId()` middleware to both project templates so every generated API has request tracing from day one.

**Architecture:** All changes are in `scripts/setup-project.sh` — the three inline heredoc templates (Cloudflare index.ts, Node.js index.ts, health test) are updated. No new files created.

**Tech Stack:** Hono `requestId()` middleware (built-in, zero dependencies)

---

### Task 1: Add requestId middleware to Cloudflare Workers template

**Files:**
- Modify: `scripts/setup-project.sh:171-200` (Cloudflare Workers index.ts heredoc)

**Step 1: Add the import and middleware**

In the Cloudflare Workers heredoc (line 171-200), change:

```bash
  write_file "$API_DIR/src/index.ts" << 'SRCEOF'
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
  LOG_LEVEL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', logger());
app.use('*', cors());
app.use('*', secureHeaders());
app.use('*', requestId());

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    requestId: c.get('requestId'),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (c) => {
  return c.json({ message: 'Nerva API', version: '0.0.1' });
});

export default app;
SRCEOF
```

**Step 2: Verify the edit**

Visually confirm lines 171-200 in setup-project.sh match the above.

**Step 3: Commit**

```bash
git add scripts/setup-project.sh
git commit -m "feat: add requestId middleware to Cloudflare Workers template"
```

---

### Task 2: Add requestId middleware to Node.js template

**Files:**
- Modify: `scripts/setup-project.sh:202-227` (Node.js index.ts heredoc)

**Step 1: Add the import and middleware**

In the Node.js heredoc (line 202-227), change:

```bash
  write_file "$API_DIR/src/index.ts" << 'SRCEOF'
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { serve } from '@hono/node-server';

const app = new Hono();

app.use('*', logger());
app.use('*', cors());
app.use('*', secureHeaders());
app.use('*', requestId());

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    requestId: c.get('requestId'),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (c) => {
  return c.json({ message: 'Nerva API', version: '0.0.1' });
});

const port = Number(process.env.PORT) || 3000;
console.log(`Server starting on port ${port}`);

serve({ fetch: app.fetch, port });
SRCEOF
```

**Step 2: Verify the edit**

Visually confirm the Node.js heredoc matches the above.

**Step 3: Commit**

```bash
git add scripts/setup-project.sh
git commit -m "feat: add requestId middleware to Node.js template"
```

---

### Task 3: Update health endpoint test

**Files:**
- Modify: `scripts/setup-project.sh:297-312` (health test heredoc)

**Step 1: Update the test to verify requestId**

Replace the health test heredoc (lines 297-312) with:

```bash
write_file "$API_DIR/tests/unit/health.test.ts" << 'HTEOF'
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';

describe('Health endpoint', () => {
  const app = new Hono();
  app.use('*', requestId());
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      requestId: c.get('requestId'),
    }),
  );

  it('should return ok status', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('should return a requestId', async () => {
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.requestId).toBeDefined();
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it('should include X-Request-Id response header', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('X-Request-Id')).toBeDefined();
  });
});
HTEOF
```

**Step 2: Verify the edit**

Visually confirm the test heredoc in setup-project.sh matches the above.

**Step 3: Commit**

```bash
git add scripts/setup-project.sh
git commit -m "test: update health test to verify requestId middleware"
```

---

### Task 4: Run dry-run and verify CI

**Step 1: Run dry-run for both platforms**

```bash
cd /c/Users/Paul\ Mulligan/PMDS/Projects/Nerva
./scripts/setup-project.sh test-cf --cloudflare --dry-run
./scripts/setup-project.sh test-node --node --dry-run
```

Expected: Both complete without errors, showing "Would generate" messages.

**Step 2: Run any existing CI/lint checks**

```bash
# Check the shell script for syntax errors
bash -n scripts/setup-project.sh
```

Expected: No output (clean parse).

**Step 3: Final commit (if any fixups needed)**

Only if prior steps revealed issues.
