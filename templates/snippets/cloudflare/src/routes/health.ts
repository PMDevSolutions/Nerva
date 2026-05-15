import { Hono } from 'hono';
import { parseConfig, type Config } from '../config';
import { pingDatabase } from '../db/ping';

const startTime = Date.now();

type Bindings = {
  HYPERDRIVE: Hyperdrive | undefined;
  APP_VERSION: string;
  HEALTH_DB_TIMEOUT_MS: string;
};

type Variables = {
  config: Config;
};

export const healthRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>().get(
  '/',
  async (c) => {
    const config = c.var.config ?? parseConfig(c.env);

    const timeout = new Promise<'disconnected'>((resolve) =>
      setTimeout(() => resolve('disconnected'), config.HEALTH_DB_TIMEOUT_MS),
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
      version: config.APP_VERSION,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      requestId: c.get('requestId'),
      checks: { database },
    };
    return c.json(body, status === 'healthy' ? 200 : 503);
  },
);
