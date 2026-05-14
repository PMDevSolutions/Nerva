import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { healthRoutes } from './routes/health';
// Note: Response compression is handled automatically by Cloudflare's edge network.
// No compress() middleware is needed for Workers deployments.

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  HYPERDRIVE: Hyperdrive;
  APP_VERSION: string;
  HEALTH_DB_TIMEOUT_MS: string;
  ENVIRONMENT: string;
  LOG_LEVEL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', logger());
app.use('*', cors());
app.use('*', etag());
app.use('*', secureHeaders());
app.use('*', requestId());

app.route('/health', healthRoutes);

app.get('/', (c) => {
  return c.json({ message: 'Nerva API', version: '0.0.1' });
});

export default app;
