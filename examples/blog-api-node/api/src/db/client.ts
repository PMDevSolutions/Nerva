import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

// Driver-agnostic database type: satisfied by the postgres-js client used in
// production (src/index.ts) and by the PGlite client used in tests
// (tests/helpers.ts), so routes never know which driver they run on.
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbClient {
  client: postgres.Sql;
  db: PostgresJsDatabase<typeof schema>;
}

export function createDbClient(databaseUrl: string): DbClient {
  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });
  return { client, db };
}
