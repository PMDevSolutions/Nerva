import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { config } from './config';
import { healthRoutes } from './routes/health';
// Note: compress() is omitted. Compressing responses inside the function burns
// billed CPU on every invocation; put CloudFront in front of the API instead.

const app = new Hono();

app.use('*', logger());
app.use('*', cors());
app.use('*', etag());
app.use('*', secureHeaders());
app.use('*', requestId());

app.route('/health', healthRoutes);

app.get('/', (c) => {
  return c.json({ message: 'Nerva API', version: config.APP_VERSION });
});

export default app;
