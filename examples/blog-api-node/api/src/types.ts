import type { RequestIdVariables } from 'hono/request-id';
import type { Database } from './db/client.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface AppEnv {
  Variables: RequestIdVariables & {
    db: Database;
    // Set by the requireAuth middleware; only read in handlers behind it.
    user: AuthUser;
  };
}
