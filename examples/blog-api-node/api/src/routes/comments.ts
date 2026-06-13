import { asc, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { comments, posts, publicUserColumns } from '../db/schema.js';
import { apiError } from '../lib/errors.js';
import { pageMeta, paginationQuerySchema } from '../lib/pagination.js';
import { validate } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import type { AppEnv } from '../types.js';

const postIdParamSchema = z.object({ postId: z.uuid() });
const idParamSchema = z.object({ id: z.uuid() });

const createCommentSchema = z.object({
  body: z.string().min(1).max(5_000),
});

// Mounted at /posts/:postId/comments.
export const postCommentsRoutes = new Hono<AppEnv>()
  // GET /posts/:postId/comments — comments on a post, oldest first, paginated.
  .get(
    '/',
    validate('param', postIdParamSchema),
    validate('query', paginationQuerySchema),
    async (c) => {
      const { postId } = c.req.valid('param');
      const pagination = c.req.valid('query');
      const db = c.var.db;

      const [post] = await db.select({ id: posts.id }).from(posts).where(eq(posts.id, postId));
      if (!post) {
        return apiError(c, 404, 'NOT_FOUND', 'Post not found');
      }

      const [data, [totalRow]] = await Promise.all([
        db.query.comments.findMany({
          where: eq(comments.postId, postId),
          with: { author: { columns: publicUserColumns } },
          orderBy: [asc(comments.createdAt)],
          limit: pagination.limit,
          offset: pagination.offset,
        }),
        db.select({ total: count() }).from(comments).where(eq(comments.postId, postId)),
      ]);

      return c.json({ data, meta: pageMeta(totalRow?.total ?? 0, pagination) });
    },
  )

  // POST /posts/:postId/comments — comment as the authenticated user.
  .post(
    '/',
    requireAuth,
    validate('param', postIdParamSchema),
    validate('json', createCommentSchema),
    async (c) => {
      const { postId } = c.req.valid('param');
      const { body } = c.req.valid('json');
      const db = c.var.db;

      const [post] = await db.select({ id: posts.id }).from(posts).where(eq(posts.id, postId));
      if (!post) {
        return apiError(c, 404, 'NOT_FOUND', 'Post not found');
      }

      const [comment] = await db
        .insert(comments)
        .values({ postId, authorId: c.var.user.id, body })
        .returning();
      if (!comment) {
        return apiError(c, 500, 'INTERNAL_ERROR', 'Failed to create comment');
      }
      return c.json({ data: comment }, 201);
    },
  );

// Mounted at /comments.
export const commentsRoutes = new Hono<AppEnv>()
  // DELETE /comments/:id — comment author only.
  .delete('/:id', requireAuth, validate('param', idParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const db = c.var.db;

    const [existing] = await db
      .select({ authorId: comments.authorId })
      .from(comments)
      .where(eq(comments.id, id));
    if (!existing) {
      return apiError(c, 404, 'NOT_FOUND', 'Comment not found');
    }
    if (existing.authorId !== c.var.user.id) {
      return apiError(c, 403, 'FORBIDDEN', 'Only the author can delete this comment');
    }

    await db.delete(comments).where(eq(comments.id, id));
    return c.body(null, 204);
  });
