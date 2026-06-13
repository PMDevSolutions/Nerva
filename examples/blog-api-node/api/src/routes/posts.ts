import { count, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { posts, publicUserColumns } from '../db/schema.js';
import { apiError } from '../lib/errors.js';
import { pageMeta, paginationQuerySchema } from '../lib/pagination.js';
import { validate } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import type { AppEnv } from '../types.js';

const idParamSchema = z.object({ id: z.uuid() });

const createPostSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(50_000),
});

const updatePostSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    content: z.string().min(1).max(50_000).optional(),
  })
  .refine((body) => body.title !== undefined || body.content !== undefined, {
    message: 'At least one of title or content is required',
  });

export const postsRoutes = new Hono<AppEnv>()
  // GET /posts — all posts with their author, newest first, paginated.
  .get('/', validate('query', paginationQuerySchema), async (c) => {
    const pagination = c.req.valid('query');
    const db = c.var.db;

    const [data, [totalRow]] = await Promise.all([
      db.query.posts.findMany({
        with: { author: { columns: publicUserColumns } },
        orderBy: [desc(posts.createdAt)],
        limit: pagination.limit,
        offset: pagination.offset,
      }),
      db.select({ total: count() }).from(posts),
    ]);

    return c.json({ data, meta: pageMeta(totalRow?.total ?? 0, pagination) });
  })

  // GET /posts/:id — a single post with its author.
  .get('/:id', validate('param', idParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const post = await c.var.db.query.posts.findFirst({
      where: eq(posts.id, id),
      with: { author: { columns: publicUserColumns } },
    });
    if (!post) {
      return apiError(c, 404, 'NOT_FOUND', 'Post not found');
    }
    return c.json({ data: post });
  })

  // POST /posts — create a post as the authenticated user.
  .post('/', requireAuth, validate('json', createPostSchema), async (c) => {
    const { title, content } = c.req.valid('json');
    const [post] = await c.var.db
      .insert(posts)
      .values({ title, content, authorId: c.var.user.id })
      .returning();
    if (!post) {
      return apiError(c, 500, 'INTERNAL_ERROR', 'Failed to create post');
    }
    return c.json({ data: post }, 201);
  })

  // PATCH /posts/:id — partial update, author only.
  .patch(
    '/:id',
    requireAuth,
    validate('param', idParamSchema),
    validate('json', updatePostSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const db = c.var.db;

      const [existing] = await db
        .select({ authorId: posts.authorId })
        .from(posts)
        .where(eq(posts.id, id));
      if (!existing) {
        return apiError(c, 404, 'NOT_FOUND', 'Post not found');
      }
      if (existing.authorId !== c.var.user.id) {
        return apiError(c, 403, 'FORBIDDEN', 'Only the author can edit this post');
      }

      const updates: { title?: string; content?: string } = {};
      if (body.title !== undefined) {
        updates.title = body.title;
      }
      if (body.content !== undefined) {
        updates.content = body.content;
      }

      const [updated] = await db
        .update(posts)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(posts.id, id))
        .returning();
      if (!updated) {
        return apiError(c, 500, 'INTERNAL_ERROR', 'Failed to update post');
      }
      return c.json({ data: updated });
    },
  )

  // DELETE /posts/:id — author only; comments cascade in the database.
  .delete('/:id', requireAuth, validate('param', idParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const db = c.var.db;

    const [existing] = await db
      .select({ authorId: posts.authorId })
      .from(posts)
      .where(eq(posts.id, id));
    if (!existing) {
      return apiError(c, 404, 'NOT_FOUND', 'Post not found');
    }
    if (existing.authorId !== c.var.user.id) {
      return apiError(c, 403, 'FORBIDDEN', 'Only the author can delete this post');
    }

    await db.delete(posts).where(eq(posts.id, id));
    return c.body(null, 204);
  });
