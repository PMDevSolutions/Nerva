import { client } from './client.js';

export async function pingDatabase(): Promise<'connected' | 'disconnected'> {
  try {
    await client`SELECT 1`;
    return 'connected';
  } catch {
    return 'disconnected';
  }
}
