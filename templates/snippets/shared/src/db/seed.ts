import { client, db } from './client.js';
import * as schema from './schema.js';

async function seed(): Promise<void> {
  console.log('Seeding database...');
  await db.insert(schema.users).values([
    { email: 'admin@example.com', name: 'Admin User' },
    { email: 'user@example.com', name: 'Test User' },
  ]);
  console.log('Database seeded successfully.');
  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
