import { resolveRequestId, isValidRequestId } from './request-id.util';

describe('request-id util', () => {
  it('reuses a valid incoming request id', () => {
    expect(resolveRequestId('test-123')).toBe('test-123');
  });

  it('generates a UUID when the header is absent', () => {
    const generated = resolveRequestId(undefined);
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('rejects invalid request ids', () => {
    expect(isValidRequestId('')).toBe(false);
    expect(isValidRequestId('has spaces')).toBe(false);
    expect(isValidRequestId('bad/id')).toBe(false);
  });
});
