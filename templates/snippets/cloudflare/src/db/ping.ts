import postgres from 'postgres';

export async function pingDatabase(
  hyperdrive: Hyperdrive | undefined,
): Promise<'connected' | 'disconnected'> {
  if (!hyperdrive?.connectionString) return 'disconnected';
  const sql = postgres(hyperdrive.connectionString, {
    max: 1,
    fetch_types: false,
  });
  try {
    await sql`SELECT 1`;
    return 'connected';
  } catch {
    return 'disconnected';
  } finally {
    void sql.end({ timeout: 1 }).catch(() => {});
  }
}
