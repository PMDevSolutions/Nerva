import { count, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { posts, users } from '../db/schema.js';
import { apiError } from '../lib/errors.js';
import { pageMeta, paginationQuerySchema } from '../lib/pagination.js';
import { validate } from '../lib/validate.js';
import type { AppEnv } from '../types.js';

const idParamSchema = z.object({ id: z.uuid() });

export const usersRoutes = new Hono<AppEnv>()
  // GET /users/:id — public profile (no email, no password hash).
  .get('/:id', validate('param', idParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const [user] = await c.var.db
      .select({ id: users.id, name: users.name, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, id));
    if (!user) {
      return apiError(c, 404, 'NOT_FOUND', 'User not found');
    }
    return c.json({ data: user });
  })

  // GET /users/:id/posts — a user's posts, newest first, paginated.
  .get(
    '/:id/posts',
    validate('param', idParamSchema),
    validate('query', paginationQuerySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const pagination = c.req.valid('query');
      const db = c.var.db;

      const [author] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
      if (!author) {
        return apiError(c, 404, 'NOT_FOUND', 'User not found');
      }

      const [data, [totalRow]] = await Promise.all([
        db.query.posts.findMany({
          where: eq(posts.authorId, id),
          orderBy: [desc(posts.createdAt)],
          limit: pagination.limit,
          offset: pagination.offset,
        }),
        db.select({ total: count() }).from(posts).where(eq(posts.authorId, id)),
      ]);

      return c.json({ data, meta: pageMeta(totalRow?.total ?? 0, pagination) });
    },
  );
