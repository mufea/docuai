import { Throttle, seconds } from '@nestjs/throttler';
import { loadDocumentsConfig } from '../../config/configuration';

/**
 * Tighter per-IP limit for presigned URL generation (upload-url and
 * download-url), configured via `DOCUMENT_PRESIGN_RATE_LIMIT` /
 * `DOCUMENT_PRESIGN_RATE_WINDOW`. Resolved lazily per request like
 * `@AuthThrottle()`; each handler has its own bucket.
 */
export const PresignThrottle = () =>
  Throttle({
    default: {
      limit: () => loadDocumentsConfig().rateLimits.presign.limit,
      ttl: () =>
        seconds(loadDocumentsConfig().rateLimits.presign.windowSeconds),
    },
  });
