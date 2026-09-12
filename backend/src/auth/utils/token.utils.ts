import { createHmac, randomBytes } from 'node:crypto';

/** 48 random bytes → 64 URL-safe characters (384 bits of entropy). */
const REFRESH_TOKEN_BYTES = 48;

/**
 * Generates an opaque refresh token from the CSPRNG. The token is returned to
 * the client exactly once and never persisted.
 */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/**
 * One-way, keyed hash of a refresh token. HMAC-SHA256 (rather than plain
 * SHA-256) means a leaked database dump cannot be used to forge lookups
 * without also knowing `JWT_REFRESH_SECRET`. Output is 64 hex characters,
 * matching the `CHAR(64)` column.
 */
export function hashRefreshToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

/** Loose shape check used to reject junk before hitting the database. */
export function looksLikeRefreshToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(token);
}
