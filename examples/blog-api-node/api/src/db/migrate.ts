import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.js';

// Programmatic migration runner for deployed environments. The compose
// `migrate` service runs `node dist/db/migrate.js` inside the production
// image, where drizzle-kit (a dev dependency) is not installed; drizzle-orm
// ships the migrator as part of the runtime package.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}

const client = postgres(databaseUrl, { max: 1 });

try {
  await migrate(drizzle(client, { schema }), { migrationsFolder: 'src/db/migrations' });
  console.log('Migrations applied.');
} finally {
  await client.end({ timeout: 5 });
}
