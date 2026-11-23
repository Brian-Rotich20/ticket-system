import { createHash, randomBytes } from 'node:crypto';

/**
 * Bearer secrets for tracking links and invitations: 32 random bytes, base64url (43 characters).
 * Only the SHA-256 hash is stored; a 256-bit random token does not need a slow hash, and lookups by hash
 * mean no token-dependent comparison happens in application code.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Cheap shape check so malformed input never reaches the database. */
export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
