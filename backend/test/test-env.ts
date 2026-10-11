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

  // Object storage: tests use a dedicated bucket so they can never touch
  // development objects. Presigned URLs must be reachable from the test
  // process itself, so the public endpoint override is dropped.
  const bucket = process.env.S3_BUCKET || 'docuai-private';
  const testBucket = process.env.TEST_S3_BUCKET || `${bucket}-test`;
  if (testBucket === bucket) {
    throw new Error(
      'TEST_S3_BUCKET must differ from S3_BUCKET. Refusing to run tests against the development bucket.',
    );
  }
  process.env.STORAGE_PROVIDER = 's3';
  process.env.S3_BUCKET = testBucket;
  process.env.TEST_S3_BUCKET = testBucket;
  process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://localhost:9000';
  delete process.env.S3_PUBLIC_ENDPOINT;
  process.env.S3_REGION = process.env.S3_REGION || 'us-east-1';
  process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'docuai-storage';
  process.env.S3_SECRET_KEY =
    process.env.S3_SECRET_KEY || 'docuai-storage-secret-dev';
  process.env.S3_FORCE_PATH_STYLE = 'true';
  process.env.S3_PRESIGNED_UPLOAD_EXPIRES_SECONDS = '300';
  process.env.S3_PRESIGNED_DOWNLOAD_EXPIRES_SECONDS = '60';
  // Small limit so oversized-file tests stay cheap; well above the test files.
  process.env.MAX_DOCUMENT_FILE_SIZE_BYTES = String(1024 * 1024);
  process.env.ALLOWED_DOCUMENT_MIME_TYPES =
    'application/pdf,image/jpeg,image/png,image/webp';
  process.env.DOCUMENT_PRESIGN_RATE_LIMIT = '1000';
  process.env.DOCUMENT_PRESIGN_RATE_WINDOW = '60';

  // OCR: a dedicated queue name (Redis db 1 is flushed by the tests) and an
  // embedded worker so e2e tests exercise the real asynchronous pipeline
  // against the real engine. Limits are small so limit tests stay cheap.
  process.env.OCR_ENABLED = 'true';
  process.env.OCR_WORKER_ENABLED =
    process.env.TEST_OCR_WORKER_ENABLED ?? 'true';
  process.env.OCR_QUEUE_NAME = 'docuai-ocr-test';
  process.env.OCR_DEFAULT_LANGUAGE = 'ind+eng';
  process.env.OCR_SUPPORTED_LANGUAGES =
    process.env.OCR_SUPPORTED_LANGUAGES ||
    'ind,eng,msa,ara,chi_sim,jpn,kor,deu,fra,spa';
  process.env.OCR_MAX_CONCURRENCY = '1';
  process.env.OCR_MAX_RETRIES = '1';
  process.env.OCR_RETRY_BACKOFF_MS = '200';
  process.env.OCR_JOB_TIMEOUT_MS = '120000';
  process.env.OCR_PAGE_TIMEOUT_MS = '60000';
  process.env.OCR_STALE_JOB_MS = '10000';
  process.env.OCR_RECONCILE_INTERVAL_MS = '5000';
  process.env.OCR_MAX_PDF_PAGES = '4';
  process.env.OCR_RENDER_DPI = '150';
  process.env.OCR_MAX_TEXT_PER_PAGE = '1000';
  process.env.OCR_MAX_TEXT_PER_DOCUMENT = '2500';
  process.env.OCR_MAX_ACTIVE_JOBS_PER_USER = '3';
  process.env.OCR_MAX_JOBS_PER_DOCUMENT = '6';
  process.env.OCR_REQUEST_RATE_LIMIT = '1000';
  process.env.OCR_REQUEST_RATE_WINDOW = '60';

  process.env.DOCUAI_TEST_ENV_PREPARED = '1';
}
