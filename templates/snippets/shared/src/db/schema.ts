import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // Soft-delete marker. NULL = row is live; a timestamp = row was soft-deleted.
  // Read queries must filter `WHERE deleted_at IS NULL` (see ./soft-delete.ts).
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
