import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { createTestDb, type TestApp, type TestDb } from '../helpers.js';

describe('GET /health', () => {
  let testDb: TestDb;
  let app: TestApp;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp(testDb.db);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  it('reports healthy when the database responds', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      checks: { database: string };
      requestId: string;
      uptime: number;
    };
    expect(body.status).toBe('healthy');
    expect(body.checks.database).toBe('connected');
    expect(body.requestId).toBeTruthy();
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('reports unhealthy with 503 when the database is down', async () => {
    const brokenDb = {
      execute: () => Promise.reject(new Error('connection refused')),
    } as unknown as Database;
    const brokenApp = createApp(brokenDb);

    const res = await brokenApp.request('/health');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; checks: { database: string } };
    expect(body.status).toBe('unhealthy');
    expect(body.checks.database).toBe('disconnected');
  });
});
