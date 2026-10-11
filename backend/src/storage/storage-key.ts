import { randomBytes } from 'node:crypto';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 24 random bytes → 32 URL-safe characters (192 bits of entropy). */
const RANDOM_SEGMENT_BYTES = 24;

export const STORAGE_KEY_PATTERN =
  /^users\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{32}$/;

/**
 * Builds the object key for a document's file:
 *
 *   users/{userId}/documents/{documentId}/{random}
 *
 * - unique and non-guessable: a fresh 192-bit random suffix per upload;
 * - ownership-aware: the owner and document ids are part of the prefix, so a
 *   bucket listing (or lifecycle rule) can be scoped per user;
 * - free of client input: the original file name never influences the key.
 *
 * Both ids are validated as UUIDs so a key can never contain path separators
 * or other characters coming from outside the server.
 */
export function buildStorageKey(userId: string, documentId: string): string {
  if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(documentId)) {
    throw new Error('Storage keys require valid UUIDs');
  }
  const random = randomBytes(RANDOM_SEGMENT_BYTES).toString('base64url');
  return `users/${userId.toLowerCase()}/documents/${documentId.toLowerCase()}/${random}`;
}

/** True when `key` has the exact shape produced by `buildStorageKey`. */
export function isServerGeneratedStorageKey(key: string): boolean {
  return STORAGE_KEY_PATTERN.test(key);
}
