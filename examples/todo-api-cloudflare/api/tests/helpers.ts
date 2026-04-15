import { Miniflare } from 'miniflare';

const MIGRATION_SQL =
  'CREATE TABLE IF NOT EXISTS todos (id text PRIMARY KEY NOT NULL, title text NOT NULL, completed integer DEFAULT 0 NOT NULL, created_at text NOT NULL, updated_at text NOT NULL);';

/**
 * Creates a Miniflare instance with a D1 database and applies the migration.
 * Returns the D1 binding and a cleanup function.
 */
export async function createTestDatabase(): Promise<{
  db: D1Database;
  cleanup: () => Promise<void>;
}> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(); } }',
    d1Databases: ['DB'],
  });

  const db = await mf.getD1Database('DB');
  await db.exec(MIGRATION_SQL);

  return {
    db,
    cleanup: () => mf.dispose(),
  };
}

/**
 * Inserts a todo directly into D1 for test setup.
 * Uses raw SQL to avoid coupling to the app layer.
 */
export async function seedTodo(
  db: D1Database,
  id: string,
  title: string,
  completed = 0,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO todos (id, title, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(id, title, completed, now, now)
    .run();
}
