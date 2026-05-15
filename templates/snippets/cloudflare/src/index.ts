import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { parseConfig, type Config } from './config';
import { healthRoutes } from './routes/health';
// Note: Response compression is handled automatically by Cloudflare's edge network.
// No compress() middleware is needed for Workers deployments.

export type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  HYPERDRIVE: Hyperdrive;
  APP_VERSION: string;
  HEALTH_DB_TIMEOUT_MS: string;
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  JWT_SECRET: string;
};

export type Variables = {
  config: Config;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use('*', async (c, next) => {
  c.set('config', parseConfig(c.env));
  await next();
});

app.use('*', logger());
app.use('*', cors());
app.use('*', etag());
app.use('*', secureHeaders());
app.use('*', requestId());

app.route('/health', healthRoutes);

app.get('/', (c) => {
  return c.json({ message: 'Nerva API', version: c.var.config.APP_VERSION });
});

export default app;
