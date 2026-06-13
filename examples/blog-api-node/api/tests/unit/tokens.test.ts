import { describe, expect, it } from 'vitest';
import { issueTokenPair, verifyToken } from '../../src/lib/tokens.js';

const USER_ID = '4f8a2c1e-0000-4000-8000-000000000001';

describe('token pair', () => {
  it('issues an access token that verifies as access', async () => {
    const { accessToken } = await issueTokenPair(USER_ID);
    await expect(verifyToken(accessToken, 'access')).resolves.toBe(USER_ID);
  });

  it('issues a refresh token that verifies as refresh', async () => {
    const { refreshToken } = await issueTokenPair(USER_ID);
    await expect(verifyToken(refreshToken, 'refresh')).resolves.toBe(USER_ID);
  });

  it('rejects an access token presented as a refresh token (and vice versa)', async () => {
    const { accessToken, refreshToken } = await issueTokenPair(USER_ID);
    await expect(verifyToken(accessToken, 'refresh')).resolves.toBeNull();
    await expect(verifyToken(refreshToken, 'access')).resolves.toBeNull();
  });

  it('rejects tampered and garbage tokens', async () => {
    const { accessToken } = await issueTokenPair(USER_ID);
    const tampered = `${accessToken.slice(0, -2)}xx`;
    await expect(verifyToken(tampered, 'access')).resolves.toBeNull();
    await expect(verifyToken('not.a.jwt', 'access')).resolves.toBeNull();
  });
});
