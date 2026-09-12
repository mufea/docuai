import { config as loadDotenv } from 'dotenv';
import * as path from 'node:path';

/**
 * Prepares process.env for the test suite.
 *
 * Safety rules:
 * - Tests only ever talk to TEST_DATABASE_URL, which must differ from
 *   DATABASE_URL so a test run can never truncate development data.
 * - Redis uses a dedicated database index (1) so FLUSHDB in tests never
 *   touches application data in index 0.
 */
export function prepareTestEnv(): void {
  // globalSetup and the per-file setup may share one process (--runInBand);
  // never re-derive from an environment that has already been rewritten.
  if (process.env.DOCUAI_TEST_ENV_PREPARED === '1') return;

  loadDotenv({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Refusing to run tests against an unknown database.',
    );
  }
  if (testDatabaseUrl === process.env.DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL must differ from DATABASE_URL. Refusing to run tests against the development database.',
    );
  }

  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379/0');
  redisUrl.pathname = '/1';

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.REDIS_URL = redisUrl.toString();
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'error';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.THROTTLE_LIMIT = process.env.TEST_THROTTLE_LIMIT ?? '10000';
  process.env.THROTTLE_TTL = '60';

  // Deterministic auth settings so tests never depend on the developer's .env.
  process.env.JWT_ACCESS_SECRET =
    'test-access-secret-0123456789abcdef0123456789abcdef';
  process.env.JWT_REFRESH_SECRET =
    'test-refresh-secret-0123456789abcdef0123456789abcdef';
  process.env.JWT_ACCESS_EXPIRES_IN = '15m';
  process.env.JWT_REFRESH_EXPIRES_IN = '30d';
  // Generous auth limits by default; the rate-limit spec lowers them itself.
  process.env.AUTH_LOGIN_RATE_LIMIT = '1000';
  process.env.AUTH_LOGIN_RATE_WINDOW = '60';
  process.env.AUTH_REGISTER_RATE_LIMIT = '1000';
  process.env.AUTH_REGISTER_RATE_WINDOW = '60';
  process.env.AUTH_REFRESH_RATE_LIMIT = '1000';
  process.env.AUTH_REFRESH_RATE_WINDOW = '60';

  process.env.DOCUAI_TEST_ENV_PREPARED = '1';
}
