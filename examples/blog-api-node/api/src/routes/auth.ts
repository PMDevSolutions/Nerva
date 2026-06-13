import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { users } from '../db/schema.js';
import { apiError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { issueTokenPair, verifyToken } from '../lib/tokens.js';
import { validate } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import type { AppEnv } from '../types.js';

const registerSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// What auth endpoints return about the caller's own account (email included,
// password hash never).
const ownUserSelection = {
  id: users.id,
  email: users.email,
  name: users.name,
  createdAt: users.createdAt,
};

export const authRoutes = new Hono<AppEnv>()
  // POST /auth/register — create an account and sign in.
  .post('/register', validate('json', registerSchema), async (c) => {
    const { email, name, password } = c.req.valid('json');
    const db = c.var.db;

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing.length > 0) {
      return apiError(c, 409, 'CONFLICT', 'An account with this email already exists');
    }

    const passwordHash = await hashPassword(password);
    const [user] = await db
      .insert(users)
      .values({ email, name, passwordHash })
      .returning(ownUserSelection);
    if (!user) {
      return apiError(c, 500, 'INTERNAL_ERROR', 'Failed to create user');
    }

    const tokens = await issueTokenPair(user.id);
    return c.json({ data: { user, ...tokens } }, 201);
  })

  // POST /auth/login — exchange credentials for a token pair.
  .post('/login', validate('json', loginSchema), async (c) => {
    const { email, password } = c.req.valid('json');
    const [user] = await c.var.db
      .select({ ...ownUserSelection, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email));

    // Same response for unknown email and wrong password.
    const valid = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !valid) {
      return apiError(c, 401, 'UNAUTHORIZED', 'Invalid email or password');
    }

    const tokens = await issueTokenPair(user.id);
    const { passwordHash: _passwordHash, ...publicUser } = user;
    return c.json({ data: { user: publicUser, ...tokens } });
  })

  // POST /auth/refresh — exchange a refresh token for a fresh token pair.
  .post('/refresh', validate('json', refreshSchema), async (c) => {
    const { refreshToken } = c.req.valid('json');
    const userId = await verifyToken(refreshToken, 'refresh');
    if (!userId) {
      return apiError(c, 401, 'UNAUTHORIZED', 'Invalid or expired refresh token');
    }

    const [user] = await c.var.db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!user) {
      return apiError(c, 401, 'UNAUTHORIZED', 'User no longer exists');
    }

    const tokens = await issueTokenPair(userId);
    return c.json({ data: tokens });
  })

  // GET /auth/me — the authenticated caller's own profile.
  .get('/me', requireAuth, async (c) => {
    const [user] = await c.var.db
      .select(ownUserSelection)
      .from(users)
      .where(eq(users.id, c.var.user.id));
    if (!user) {
      return apiError(c, 404, 'NOT_FOUND', 'User not found');
    }
    return c.json({ data: user });
  });
