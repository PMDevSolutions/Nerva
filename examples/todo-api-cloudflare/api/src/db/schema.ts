import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const todos = sqliteTable('todos', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});
