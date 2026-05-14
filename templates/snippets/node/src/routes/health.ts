import { Hono } from 'hono';
import { pingDatabase } from '../db/ping';

const startTime = Date.now();

export const healthRoutes = new Hono().get('/', async (c) => {
  const timeoutMs = Number(process.env.HEALTH_DB_TIMEOUT_MS) || 2000;
  const timeout = new Promise<'disconnected'>((resolve) =>
    setTimeout(() => resolve('disconnected'), timeoutMs),
  );

  let database: 'connected' | 'disconnected';
  try {
    database = await Promise.race([pingDatabase(), timeout]);
  } catch {
    database = 'disconnected';
  }

  const status = database === 'connected' ? 'healthy' : 'unhealthy';
  const body = {
    status,
    version: process.env.APP_VERSION ?? 'unknown',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    requestId: c.get('requestId'),
    checks: { database },
  };
  return c.json(body, status === 'healthy' ? 200 : 503);
});
