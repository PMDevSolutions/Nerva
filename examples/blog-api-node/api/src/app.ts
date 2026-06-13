import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { config } from './config.js';
import type { Database } from './db/client.js';
import { apiError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { commentsRoutes, postCommentsRoutes } from './routes/comments.js';
import { healthRoutes } from './routes/health.js';
import { postsRoutes } from './routes/posts.js';
import { usersRoutes } from './routes/users.js';
import type { AppEnv } from './types.js';

/**
 * Builds the Hono app around an injected database, so production
 * (src/index.ts, postgres-js pool) and tests (tests/helpers.ts, PGlite) run
 * the exact same application code.
 */
export function createApp(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });

  if (config.NODE_ENV !== 'test') {
    app.use('*', logger());
  }
  app.use('*', cors());
  app.use('*', compress());
  app.use('*', etag());
  app.use('*', secureHeaders());
  app.use('*', requestId());

  app.route('/health', healthRoutes);
  app.route('/auth', authRoutes);
  app.route('/users', usersRoutes);
  app.route('/posts', postsRoutes);
  app.route('/posts/:postId/comments', postCommentsRoutes);
  app.route('/comments', commentsRoutes);

  app.get('/', (c) => c.json({ message: 'Blog API (Nerva example)', version: config.APP_VERSION }));

  app.notFound((c) => apiError(c, 404, 'NOT_FOUND', 'Route not found'));
  app.onError((err, c) => {
    console.error('Unhandled error:', err);
    return apiError(c, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  });

  return app;
}
