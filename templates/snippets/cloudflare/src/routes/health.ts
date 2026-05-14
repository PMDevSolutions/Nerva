import { Hono } from 'hono';
import { pingDatabase } from '../db/ping';

const startTime = Date.now();

type Bindings = {
  HYPERDRIVE: Hyperdrive;
  APP_VERSION: string;
  HEALTH_DB_TIMEOUT_MS: string;
};

export const healthRoutes = new Hono<{ Bindings: Bindings }>().get('/', async (c) => {
  const timeoutMs = Number(c.env.HEALTH_DB_TIMEOUT_MS) || 2000;
  const timeout = new Promise<'disconnected'>((resolve) =>
    setTimeout(() => resolve('disconnected'), timeoutMs),
  );

  let database: 'connected' | 'disconnected';
  try {
    database = await Promise.race([pingDatabase(c.env.HYPERDRIVE), timeout]);
  } catch {
    database = 'disconnected';
  }

  const status = database === 'connected' ? 'healthy' : 'unhealthy';
  const body = {
    status,
    version: c.env.APP_VERSION ?? 'unknown',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    requestId: c.get('requestId'),
    checks: { database },
  };
  return c.json(body, status === 'healthy' ? 200 : 503);
});
