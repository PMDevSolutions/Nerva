import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { config } from '../config.js';
import type { AppEnv } from '../types.js';

const startTime = Date.now();

export const healthRoutes = new Hono<AppEnv>().get('/', async (c) => {
  const timeout = new Promise<'disconnected'>((resolve) => {
    setTimeout(() => {
      resolve('disconnected');
    }, config.HEALTH_DB_TIMEOUT_MS);
  });

  const ping = async (): Promise<'connected'> => {
    await c.var.db.execute(sql`SELECT 1`);
    return 'connected';
  };

  let database: 'connected' | 'disconnected';
  try {
    database = await Promise.race([ping(), timeout]);
  } catch {
    database = 'disconnected';
  }

  const status = database === 'connected' ? 'healthy' : 'unhealthy';
  const body = {
    status,
    version: config.APP_VERSION,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    requestId: c.get('requestId'),
    checks: { database },
  };
  return c.json(body, status === 'healthy' ? 200 : 503);
});
