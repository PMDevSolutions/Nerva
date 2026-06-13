import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { config } from './config.js';
import { createDbClient } from './db/client.js';

const { client, db } = createDbClient(config.DATABASE_URL);
const app = createApp(db);

console.log(`Server starting on port ${String(config.PORT)}`);

const server = serve({ fetch: app.fetch, port: config.PORT });

// --- Graceful shutdown ---
const SHUTDOWN_TIMEOUT_MS = 10_000;
let isShuttingDown = false;

function shutdown(signal: string): void {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.log(`\n${signal} received. Shutting down gracefully...`);

  const forceExit = setTimeout(() => {
    console.error(`Forced shutdown after ${String(SHUTDOWN_TIMEOUT_MS / 1000)}s timeout.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close(() => {
    console.log('HTTP server closed.');
    client
      .end({ timeout: 5 })
      .then(() => {
        console.log('Database pool closed. Shutdown complete.');
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error('Error closing database pool:', err);
        process.exit(1);
      });
  });
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
