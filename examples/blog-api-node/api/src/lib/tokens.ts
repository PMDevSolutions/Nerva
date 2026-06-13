import { jwtVerify, SignJWT } from 'jose';
import { config } from '../config.js';

const JWT_ISSUER = 'blog-api-node';
const JWT_AUDIENCE = 'blog-api-node:client';
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '7d';

const secret = new TextEncoder().encode(config.JWT_SECRET);

export type TokenType = 'access' | 'refresh';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

async function signToken(userId: string, type: TokenType, ttl: string): Promise<string> {
  return new SignJWT({ type })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret);
}

export async function issueTokenPair(userId: string): Promise<TokenPair> {
  return {
    accessToken: await signToken(userId, 'access', ACCESS_TOKEN_TTL),
    refreshToken: await signToken(userId, 'refresh', REFRESH_TOKEN_TTL),
  };
}

/**
 * Returns the user id (`sub`) when the token is valid, unexpired, and of the
 * expected type; otherwise null. The type claim prevents a refresh token from
 * being replayed as an access token (and vice versa).
 */
export async function verifyToken(token: string, expectedType: TokenType): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    if (payload.type !== expectedType || typeof payload.sub !== 'string') {
      return null;
    }
    return payload.sub;
  } catch {
    return null;
  }
}
