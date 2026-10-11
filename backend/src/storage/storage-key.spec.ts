import { randomUUID } from 'node:crypto';
import {
  STORAGE_KEY_PATTERN,
  buildStorageKey,
  isServerGeneratedStorageKey,
} from './storage-key';

describe('buildStorageKey', () => {
  const userId = randomUUID();
  const documentId = randomUUID();

  it('produces users/{userId}/documents/{documentId}/{random}', () => {
    const key = buildStorageKey(userId, documentId);

    expect(key).toMatch(STORAGE_KEY_PATTERN);
    expect(key.startsWith(`users/${userId}/documents/${documentId}/`)).toBe(
      true,
    );
    expect(isServerGeneratedStorageKey(key)).toBe(true);
  });

  it('is unique per call', () => {
    const keys = new Set(
      Array.from({ length: 50 }, () => buildStorageKey(userId, documentId)),
    );
    expect(keys.size).toBe(50);
  });

  it('refuses anything that is not a UUID (no path injection)', () => {
    expect(() => buildStorageKey('../other-user', documentId)).toThrow();
    expect(() => buildStorageKey(userId, 'x/y')).toThrow();
    expect(() => buildStorageKey('', documentId)).toThrow();
  });

  it('rejects client-shaped keys', () => {
    expect(isServerGeneratedStorageKey('uploads/invoice.pdf')).toBe(false);
    expect(isServerGeneratedStorageKey('users/another-user/private.pdf')).toBe(
      false,
    );
    expect(isServerGeneratedStorageKey('')).toBe(false);
  });
});
