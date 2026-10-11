import { Throttle, seconds } from '@nestjs/throttler';
import { loadOcrConfig } from '../../config/configuration';

/**
 * Tighter per-IP limit for job-creating OCR endpoints (request and retry),
 * configured via `OCR_REQUEST_RATE_LIMIT` / `OCR_REQUEST_RATE_WINDOW`.
 * Resolved lazily per request like `@PresignThrottle()`.
 */
export const OcrThrottle = () =>
  Throttle({
    default: {
      limit: () => loadOcrConfig().rateLimits.request.limit,
      ttl: () => seconds(loadOcrConfig().rateLimits.request.windowSeconds),
    },
  });
