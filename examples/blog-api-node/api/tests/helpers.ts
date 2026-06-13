import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Hono } from 'hono';
import type { Database } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import type { AppEnv } from '../src/types.js';

export interface TestDb {
  db: Database;
  /** Empties all tables (foreign-key order). Call from beforeEach. */
  reset: () => Promise<void>;
  /** Disposes the PGlite instance. Call from afterAll. */
  cleanup: () => Promise<void>;
}

/**
 * In-process PostgreSQL (PGlite) with the committed migrations applied — the
 * same SQL that runs against the real database in docker compose. No Docker
 * or external services needed to run the test suite.
 */
export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite();
  const db = drizzle(pglite, { schema });
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  return {
    db,
    reset: async () => {
      await db.delete(schema.comments);
      await db.delete(schema.posts);
      await db.delete(schema.users);
    },
    cleanup: () => pglite.close(),
  };
}

export type TestApp = Hono<AppEnv>;

export function jsonHeaders(token?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export interface RegisteredUser {
  id: string;
  email: string;
  name: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

let userCounter = 0;

export async function registerUser(
  app: TestApp,
  overrides: Partial<Pick<RegisteredUser, 'email' | 'name' | 'password'>> = {},
): Promise<RegisteredUser> {
  userCounter += 1;
  const credentials = {
    email: overrides.email ?? `user-${String(userCounter)}@example.com`,
    name: overrides.name ?? `User ${String(userCounter)}`,
    password: overrides.password ?? 'password123',
  };
  const res = await app.request('/auth/register', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(credentials),
  });
  if (res.status !== 201) {
    throw new Error(`registerUser expected 201, got ${String(res.status)}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data: { user: { id: string }; accessToken: string; refreshToken: string };
  };
  return {
    id: body.data.user.id,
    ...credentials,
    accessToken: body.data.accessToken,
    refreshToken: body.data.refreshToken,
  };
}

export interface CreatedPost {
  id: string;
  title: string;
  content: string;
  authorId: string;
}

export async function createPost(
  app: TestApp,
  accessToken: string,
  overrides: Partial<Pick<CreatedPost, 'title' | 'content'>> = {},
): Promise<CreatedPost> {
  const res = await app.request('/posts', {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify({
      title: overrides.title ?? 'A test post',
      content: overrides.content ?? 'Some test content.',
    }),
  });
  if (res.status !== 201) {
    throw new Error(`createPost expected 201, got ${String(res.status)}: ${await res.text()}`);
  }
  const body = (await res.json()) as { data: CreatedPost };
  return body.data;
}
