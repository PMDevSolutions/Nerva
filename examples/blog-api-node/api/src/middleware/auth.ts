import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { users } from '../db/schema.js';
import { apiError } from '../lib/errors.js';
import { verifyToken } from '../lib/tokens.js';
import type { AppEnv } from '../types.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Requires a valid access token. Loads the user from the database (a token
 * for a deleted account is rejected) and exposes it as `c.var.user`.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authorization = c.req.header('Authorization');
  if (!authorization?.startsWith(BEARER_PREFIX)) {
    return apiError(c, 401, 'UNAUTHORIZED', 'Missing bearer token');
  }

  const userId = await verifyToken(authorization.slice(BEARER_PREFIX.length), 'access');
  if (!userId) {
    return apiError(c, 401, 'UNAUTHORIZED', 'Invalid or expired access token');
  }

  const [user] = await c.var.db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) {
    return apiError(c, 401, 'UNAUTHORIZED', 'User no longer exists');
  }

  c.set('user', user);
  return next();
});
