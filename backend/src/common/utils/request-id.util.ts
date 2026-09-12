import { randomUUID } from 'node:crypto';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_REQUEST_ID_LENGTH = 128;

export function isValidRequestId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}

export function resolveRequestId(incoming: unknown, fallback?: string): string {
  const candidates = [incoming, fallback];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && isValidRequestId(candidate)) {
      return candidate;
    }

    if (Array.isArray(candidate) && typeof candidate[0] === 'string') {
      if (isValidRequestId(candidate[0])) {
        return candidate[0];
      }
    }
  }

  return randomUUID();
}
