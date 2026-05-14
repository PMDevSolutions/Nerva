export async function pingDatabase(db: D1Database | undefined): Promise<'connected' | 'disconnected'> {
  if (!db) return 'disconnected';
  try {
    await db.prepare('SELECT 1').first();
    return 'connected';
  } catch {
    return 'disconnected';
  }
}
