import { Throttle, seconds } from '@nestjs/throttler';
import { AuthConfig, loadAuthConfig } from '../../config/configuration';

export type AuthThrottleKind = keyof AuthConfig['rateLimits'];

/**
 * Applies the stricter, per-endpoint authentication rate limit configured via
 * `AUTH_<KIND>_RATE_LIMIT` / `AUTH_<KIND>_RATE_WINDOW`.
 *
 * Decorators are evaluated at import time, before the Nest container exists,
 * so the limit and window are resolved lazily per request from the same
 * configuration loader that feeds `ConfigService`. The throttler keys include
 * the controller and handler name, so each auth endpoint has its own bucket.
 */
export const AuthThrottle = (kind: AuthThrottleKind) =>
  Throttle({
    default: {
      limit: () => loadAuthConfig().rateLimits[kind].limit,
      ttl: () => seconds(loadAuthConfig().rateLimits[kind].windowSeconds),
    },
  });
