import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { pingDatabase } from '../../src/db/ping';
import { healthRoutes } from '../../src/routes/health';

vi.mock('../../src/db/ping', () => ({
  pingDatabase: vi.fn(),
}));

interface HealthBody {
  status: 'healthy' | 'unhealthy';
  version: string;
  uptime: number;
  timestamp: string;
  requestId: string;
  checks: { database: 'connected' | 'disconnected' };
}

type TestEnv = {
  APP_VERSION: string;
  HEALTH_DB_TIMEOUT_MS: string;
  DB: D1Database | undefined;
};

const env: TestEnv = {
  APP_VERSION: '0.0.1',
  HEALTH_DB_TIMEOUT_MS: '2000',
  DB: undefined,
};

const makeApp = (): Hono<{ Bindings: TestEnv }> => {
  const app = new Hono<{ Bindings: TestEnv }>();
  app.use('*', requestId());
  app.route('/health', healthRoutes);
  return app;
};

const mockedPing = vi.mocked(pingDatabase);

describe('Health endpoint', () => {
  beforeEach(() => {
    mockedPing.mockReset();
  });

  it('returns 200 + healthy when DB is connected', async () => {
    mockedPing.mockResolvedValue('connected');
    const res = await makeApp().request('/health', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('healthy');
    expect(body.checks.database).toBe('connected');
  });

  it('returns version from APP_VERSION binding', async () => {
    mockedPing.mockResolvedValue('connected');
    const res = await makeApp().request('/health', {}, env);
    const body = (await res.json()) as HealthBody;
    expect(body.version).toBe('0.0.1');
  });

  it('returns numeric uptime >= 0', async () => {
    mockedPing.mockResolvedValue('connected');
    const res = await makeApp().request('/health', {}, env);
    const body = (await res.json()) as HealthBody;
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 + unhealthy when DB is disconnected', async () => {
    mockedPing.mockResolvedValue('disconnected');
    const res = await makeApp().request('/health', {}, env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('unhealthy');
    expect(body.checks.database).toBe('disconnected');
  });

  it('returns 503 when ping exceeds timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockedPing.mockImplementation(() => new Promise(() => {}));
    const reqPromise = makeApp().request('/health', {}, env);
    await vi.advanceTimersByTimeAsync(2001);
    const res = await reqPromise;
    expect(res.status).toBe(503);
    vi.useRealTimers();
  });

  it('returns 503 when ping throws (never 500)', async () => {
    mockedPing.mockRejectedValue(new Error('boom'));
    const res = await makeApp().request('/health', {}, env);
    expect(res.status).toBe(503);
  });

  it('preserves requestId in body and X-Request-Id header', async () => {
    mockedPing.mockResolvedValue('connected');
    const res = await makeApp().request('/health', {}, env);
    const body = (await res.json()) as HealthBody;
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(res.headers.get('X-Request-Id')).not.toBeNull();
  });
});
