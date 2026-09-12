import {
  generateRefreshToken,
  hashRefreshToken,
  looksLikeRefreshToken,
} from './token.utils';

describe('token.utils', () => {
  describe('generateRefreshToken', () => {
    it('returns 64 URL-safe characters', () => {
      const token = generateRefreshToken();

      expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    });

    it('never repeats', () => {
      const tokens = new Set(
        Array.from({ length: 1000 }, () => generateRefreshToken()),
      );

      expect(tokens.size).toBe(1000);
    });
  });

  describe('hashRefreshToken', () => {
    const secret = 'unit-test-secret-0123456789abcdef0123456789abcdef';

    it('is deterministic for the same token and secret', () => {
      const token = generateRefreshToken();

      expect(hashRefreshToken(token, secret)).toBe(
        hashRefreshToken(token, secret),
      );
    });

    it('produces a 64-char hex digest that differs from the token', () => {
      const token = generateRefreshToken();
      const hash = hashRefreshToken(token, secret);

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toBe(token);
    });

    it('depends on the secret', () => {
      const token = generateRefreshToken();

      expect(hashRefreshToken(token, secret)).not.toBe(
        hashRefreshToken(token, `${secret}-other`),
      );
    });

    it('differs for different tokens', () => {
      expect(hashRefreshToken(generateRefreshToken(), secret)).not.toBe(
        hashRefreshToken(generateRefreshToken(), secret),
      );
    });
  });

  describe('looksLikeRefreshToken', () => {
    it('accepts generated tokens', () => {
      expect(looksLikeRefreshToken(generateRefreshToken())).toBe(true);
    });

    it('rejects junk', () => {
      expect(looksLikeRefreshToken('')).toBe(false);
      expect(looksLikeRefreshToken('short')).toBe(false);
      expect(looksLikeRefreshToken('x'.repeat(200))).toBe(false);
      expect(looksLikeRefreshToken(`${'a'.repeat(63)}!`)).toBe(false);
      expect(looksLikeRefreshToken(42)).toBe(false);
      expect(looksLikeRefreshToken(null)).toBe(false);
    });
  });
});
