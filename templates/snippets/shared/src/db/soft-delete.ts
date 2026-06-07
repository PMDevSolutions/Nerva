import {
  and,
  eq,
  isNull,
  type SQL,
  type TablesRelationalConfig,
} from 'drizzle-orm';
import type {
  PgColumn,
  PgDatabase,
  PgQueryResultHKT,
  PgTable,
  PgUpdateSetSource,
} from 'drizzle-orm/pg-core';
import { z } from 'zod';

/**
 * Soft-delete utilities.
 *
 * The pipeline enables soft deletes by default (`database.softDeleteDefault` in
 * `.claude/pipeline.config.json`). Every soft-deletable table carries a nullable
 * `deleted_at` timestamp column. A row is "alive" while `deleted_at IS NULL` and
 * "deleted" once a timestamp is written. Records are never physically removed by
 * DELETE endpoints — `softDelete()` stamps `deleted_at` instead.
 *
 * Use {@link notDeleted} / {@link withNotDeleted} in every read query so deleted
 * rows are filtered out automatically, and {@link softDelete} in DELETE handlers.
 */

/**
 * Minimal column shape a table must expose to participate in soft deletes:
 * an `id` primary key and a nullable `deletedAt` timestamp column.
 */
export interface SoftDeleteColumns {
  id: PgColumn;
  deletedAt: PgColumn;
}

/** A Drizzle pgTable that carries the soft-delete columns. */
export type SoftDeleteTable = PgTable & SoftDeleteColumns;

/**
 * Query filter that matches only rows that have NOT been soft-deleted
 * (`WHERE deleted_at IS NULL`). Add this to the `where` clause of every read.
 *
 * @example
 *   const rows = await db.select().from(users).where(notDeleted(users));
 */
export function notDeleted(table: SoftDeleteColumns): SQL {
  return isNull(table.deletedAt);
}

/**
 * Combine the not-deleted filter with any number of additional conditions,
 * ANDed together. `undefined` conditions are ignored, mirroring Drizzle's
 * `and()` semantics.
 *
 * @example
 *   db.select().from(users).where(withNotDeleted(users, eq(users.email, email)));
 */
export function withNotDeleted(
  table: SoftDeleteColumns,
  ...conditions: Array<SQL | undefined>
): SQL | undefined {
  return and(notDeleted(table), ...conditions);
}

/**
 * Build the `where` clause for a list/read query, honouring the
 * `?include_deleted=true` admin flag. When `includeDeleted` is true the
 * soft-delete filter is omitted so deleted rows are returned alongside live
 * ones; otherwise deleted rows are excluded.
 *
 * @example
 *   const where = softDeleteFilter(users, query.include_deleted, search);
 *   await db.select().from(users).where(where);
 */
export function softDeleteFilter(
  table: SoftDeleteColumns,
  includeDeleted: boolean,
  ...conditions: Array<SQL | undefined>
): SQL | undefined {
  if (includeDeleted) {
    return and(...conditions);
  }
  return and(notDeleted(table), ...conditions);
}

/**
 * Soft-delete a single row by id: sets `deleted_at` to the current time instead
 * of issuing a physical DELETE. Already-deleted rows are not touched (the
 * `deleted_at IS NULL` guard makes the call idempotent), so the returned row
 * count is 0 when the row is missing or already deleted and 1 on success.
 *
 * @returns the number of rows transitioned from alive to deleted (0 or 1).
 *
 * @example
 *   const affected = await softDelete(db, users, id);
 *   if (affected === 0) throw new NotFoundError('User', id);
 */
export async function softDelete<
  TTable extends SoftDeleteTable,
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TQueryResult, TFullSchema, TSchema>,
  table: TTable,
  id: string | number,
): Promise<number> {
  const result = await db
    .update(table)
    .set({ deletedAt: new Date() } as unknown as PgUpdateSetSource<TTable>)
    .where(and(eq(table.id, id), notDeleted(table)))
    .returning({ id: table.id });

  return result.length;
}

/**
 * Query-param schema for admin endpoints that may opt into seeing soft-deleted
 * rows via `?include_deleted=true`. Any value other than the literal string
 * `"true"` (including an absent param) resolves to `false`.
 *
 * @example
 *   app.get('/users', zValidator('query', includeDeletedQuerySchema), (c) => {
 *     const { include_deleted } = c.req.valid('query');
 *   });
 */
export const includeDeletedQuerySchema = z.object({
  include_deleted: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((value) => value === 'true'),
});

export type IncludeDeletedQuery = z.infer<typeof includeDeletedQuerySchema>;
