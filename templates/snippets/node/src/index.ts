import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { serve } from '@hono/node-server';
import { healthRoutes } from './routes/health';

const app = new Hono();

app.use('*', logger());
app.use('*', cors());
app.use('*', compress());
app.use('*', etag());
app.use('*', secureHeaders());
app.use('*', requestId());

app.route('/health', healthRoutes);

app.get('/', (c) => {
  return c.json({ message: 'Nerva API', version: '0.0.1' });
});

const port = Number(process.env.PORT) || 3000;
console.log(`Server starting on port ${port}`);

const server = serve({ fetch: app.fetch, port });

// --- Graceful shutdown ---
const SHUTDOWN_TIMEOUT_MS = 10_000;
let isShuttingDown = false;

const shutdown = (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n${signal} received. Shutting down gracefully...`);

  const forceExit = setTimeout(() => {
    console.error(`Forced shutdown after ${SHUTDOWN_TIMEOUT_MS / 1000}s timeout.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close(() => {
    console.log('HTTP server closed.');
    // TODO: Close database connection pool when configured
    // await pool.end();
    console.log('Shutdown complete.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
