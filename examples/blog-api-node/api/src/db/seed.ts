import { hashPassword } from '../lib/password.js';
import { createDbClient } from './client.js';
import { comments, posts, users } from './schema.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}

const { client, db } = createDbClient(databaseUrl);

async function seed(): Promise<void> {
  console.log('Seeding database...');

  // Wipe in foreign-key order so the seed is repeatable.
  await db.delete(comments);
  await db.delete(posts);
  await db.delete(users);

  const passwordHash = await hashPassword('password123');
  const [alice, bob] = await db
    .insert(users)
    .values([
      { email: 'alice@example.com', name: 'Alice Author', passwordHash },
      { email: 'bob@example.com', name: 'Bob Blogger', passwordHash },
    ])
    .returning();
  if (!alice || !bob) {
    throw new Error('Failed to seed users');
  }

  const seededPosts = await db
    .insert(posts)
    .values([
      {
        authorId: alice.id,
        title: 'Hello, Nerva',
        content:
          'This blog API was generated with `setup-project.sh --node` and extended with auth, relations, and pagination. Browse the source to see how the pieces fit together.',
      },
      {
        authorId: alice.id,
        title: 'Schema-first thinking',
        content:
          'Drizzle schemas are the single source of truth here: migrations, query types, and seed data all derive from src/db/schema.ts.',
      },
      {
        authorId: bob.id,
        title: 'Shipping with Docker Compose',
        content:
          'docker compose up builds the API image, starts PostgreSQL, runs migrations, and brings the API up behind a health check.',
      },
    ])
    .returning();
  const [firstPost] = seededPosts;
  if (!firstPost) {
    throw new Error('Failed to seed posts');
  }

  await db.insert(comments).values([
    {
      postId: firstPost.id,
      authorId: bob.id,
      body: 'Great introduction — the auth flow tests are worth a read too.',
    },
    {
      postId: firstPost.id,
      authorId: alice.id,
      body: 'Thanks Bob! The refresh-token round trip is in tests/integration/auth.test.ts.',
    },
  ]);

  console.log('Database seeded: 2 users, 3 posts, 2 comments.');
  console.log('Log in with alice@example.com or bob@example.com and password "password123".');
  await client.end();
}

seed().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
