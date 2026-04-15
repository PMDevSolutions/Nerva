import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { todosRoutes } from './routes/todos';
// Note: Response compression is handled automatically by Cloudflare's edge network.
// No compress() middleware is needed for Workers deployments.

interface Bindings {
  DB: D1Database;
  ENVIRONMENT: string;
}

const app = new Hono<{ Bindings: Bindings }>();

// --- Middleware ---
app.use('*', logger());
app.use('*', cors());
app.use('*', etag());
app.use('*', secureHeaders());
app.use('*', requestId());

// --- Health check ---
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    requestId: c.get('requestId'),
    timestamp: new Date().toISOString(),
  });
});

// --- Routes ---
app.route('/todos', todosRoutes);

// --- Root ---
app.get('/', (c) => {
  return c.json({ message: 'Todo API', version: '0.0.1' });
});

export default app;
