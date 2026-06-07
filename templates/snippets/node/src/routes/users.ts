import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import {
  includeDeletedQuerySchema,
  softDelete,
  softDeleteFilter,
} from '../db/soft-delete';

/**
 * Example resource routes demonstrating the soft-delete pattern from
 * `../db/soft-delete`. Wire them into the app where a database is available:
 *
 *   import { usersRoutes } from './routes/users';
 *   app.route('/users', usersRoutes);
 *
 * Soft-delete rules of thumb:
 *   - Reads filter out deleted rows with `softDeleteFilter` (or `notDeleted`).
 *   - `?include_deleted=true` lets admin callers see soft-deleted rows; the
 *     `includeDeletedQuerySchema` parses that flag into a boolean.
 *   - DELETE stamps `deleted_at` via `softDelete` instead of removing the row.
 */
export const usersRoutes = new Hono()
  // GET /users — list active users. Admins pass ?include_deleted=true for all.
  .get('/', async (c) => {
    const { include_deleted } = includeDeletedQuerySchema.parse(c.req.query());
    const rows = await db
      .select()
      .from(users)
      .where(softDeleteFilter(users, include_deleted));
    return c.json({ users: rows, total: rows.length });
  })

  // GET /users/:id — fetch one user. Soft-deleted rows return 404 unless
  // ?include_deleted=true is supplied.
  .get('/:id', async (c) => {
    const id = c.req.param('id');
    const { include_deleted } = includeDeletedQuerySchema.parse(c.req.query());
    const rows = await db
      .select()
      .from(users)
      .where(softDeleteFilter(users, include_deleted, eq(users.id, id)));
    const user = rows[0];
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json(user);
  })

  // DELETE /users/:id — soft delete: stamps deleted_at instead of removing.
  // `softDelete` returns the number of rows transitioned to deleted (0 or 1),
  // so a missing or already-deleted row resolves to a 404.
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const affected = await softDelete(db, users, id);
    if (affected === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json({ message: 'User deleted' });
  });
