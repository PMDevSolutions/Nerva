import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/lib/password.js';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('password123');
    await expect(verifyPassword('password123', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('password123');
    await expect(verifyPassword('not-the-password', hash)).resolves.toBe(false);
  });

  it('salts hashes (same password, different hashes)', async () => {
    const first = await hashPassword('password123');
    const second = await hashPassword('password123');
    expect(first).not.toBe(second);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    await expect(verifyPassword('password123', 'not-a-valid-hash')).resolves.toBe(false);
    await expect(verifyPassword('password123', '')).resolves.toBe(false);
  });
});
