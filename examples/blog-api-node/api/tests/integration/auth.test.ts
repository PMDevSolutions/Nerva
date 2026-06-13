import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createTestDb, jsonHeaders, registerUser, type TestApp, type TestDb } from '../helpers.js';

interface ErrorBody {
  error: { code: string; message: string; details?: { field: string; message: string }[] };
}

let testDb: TestDb;
let app: TestApp;

beforeAll(async () => {
  testDb = await createTestDb();
  app = createApp(testDb.db);
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

describe('POST /auth/register', () => {
  it('creates an account and returns the user with a token pair', async () => {
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: 'ada@example.com', name: 'Ada', password: 'password123' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { user: Record<string, unknown>; accessToken: string; refreshToken: string };
    };
    expect(body.data.user).toMatchObject({ email: 'ada@example.com', name: 'Ada' });
    expect(body.data.user).not.toHaveProperty('passwordHash');
    expect(body.data.accessToken).toBeTruthy();
    expect(body.data.refreshToken).toBeTruthy();
  });

  it('rejects a duplicate email with 409 CONFLICT', async () => {
    await registerUser(app, { email: 'taken@example.com' });
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: 'taken@example.com', name: 'Dupe', password: 'password123' }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('CONFLICT');
  });

  it('rejects an invalid payload with 400 VALIDATION_ERROR and field details', async () => {
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: 'not-an-email', name: '', password: 'short' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const fields = (body.error.details ?? []).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['email', 'name', 'password']));
  });
});

describe('POST /auth/login', () => {
  it('returns a token pair for valid credentials', async () => {
    const user = await registerUser(app);
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: user.email, password: user.password }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { user: { id: string }; accessToken: string; refreshToken: string };
    };
    expect(body.data.user.id).toBe(user.id);
    expect(body.data.accessToken).toBeTruthy();
    expect(body.data.refreshToken).toBeTruthy();
  });

  it('rejects a wrong password with 401', async () => {
    const user = await registerUser(app);
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: user.email, password: 'wrong-password' }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('answers unknown emails exactly like wrong passwords', async () => {
    const user = await registerUser(app);
    const wrongPassword = await app.request('/auth/login', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: user.email, password: 'wrong-password' }),
    });
    const unknownEmail = await app.request('/auth/login', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: 'ghost@example.com', password: 'password123' }),
    });

    expect(unknownEmail.status).toBe(401);
    expect(await unknownEmail.json()).toEqual(await wrongPassword.json());
  });
});

describe('POST /auth/refresh', () => {
  it('exchanges a refresh token for a working new token pair', async () => {
    const user = await registerUser(app);
    const refreshRes = await app.request('/auth/refresh', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ refreshToken: user.refreshToken }),
    });

    expect(refreshRes.status).toBe(200);
    const body = (await refreshRes.json()) as {
      data: { accessToken: string; refreshToken: string };
    };

    // The freshly minted access token must be accepted by a protected route.
    const meRes = await app.request('/auth/me', { headers: jsonHeaders(body.data.accessToken) });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { data: { id: string; email: string } };
    expect(me.data.id).toBe(user.id);
  });

  it('rejects an access token presented as a refresh token', async () => {
    const user = await registerUser(app);
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ refreshToken: user.accessToken }),
    });

    expect(res.status).toBe(401);
  });

  it('rejects garbage refresh tokens', async () => {
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ refreshToken: 'not-a-token' }),
    });

    expect(res.status).toBe(401);
  });
});

describe('GET /auth/me', () => {
  it('returns the authenticated profile including the email', async () => {
    const user = await registerUser(app);
    const res = await app.request('/auth/me', { headers: jsonHeaders(user.accessToken) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; email: string; name: string } };
    expect(body.data).toMatchObject({ id: user.id, email: user.email, name: user.name });
  });

  it('rejects requests without a token', async () => {
    const res = await app.request('/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects requests with an invalid token', async () => {
    const res = await app.request('/auth/me', { headers: jsonHeaders('bogus-token') });
    expect(res.status).toBe(401);
  });

  it('rejects a valid token whose user has been deleted', async () => {
    const user = await registerUser(app);
    await testDb.reset();

    const res = await app.request('/auth/me', { headers: jsonHeaders(user.accessToken) });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('tokens for deleted accounts', () => {
  it('refuses to refresh for a user that no longer exists', async () => {
    const user = await registerUser(app);
    await testDb.reset();

    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ refreshToken: user.refreshToken }),
    });
    expect(res.status).toBe(401);
  });
});
