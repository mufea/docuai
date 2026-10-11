import * as Joi from 'joi';

const DURATION_PATTERN = /^\d+[smhd]?$/i;

/** Placeholders shipped in .env.example; never accepted. */
const PLACEHOLDER_SECRETS = [
  'CHANGE_ME_TO_A_LONG_RANDOM_SECRET',
  'CHANGE_ME_TO_ANOTHER_LONG_RANDOM_SECRET',
];

/** Defaults used by docker-compose for local development; refused in production. */
export const DEV_ONLY_SECRETS = [
  'dev-only-insecure-access-secret-do-not-use-in-production',
  'dev-only-insecure-refresh-secret-do-not-use-in-production',
];

/** Placeholder storage credentials shipped in .env.example; never accepted. */
const PLACEHOLDER_STORAGE_CREDENTIALS = ['CHANGE_ME'];

/** Local object-storage credentials from docker-compose; refused in production. */
export const DEV_ONLY_STORAGE_CREDENTIALS = [
  'docuai-storage',
  'docuai-storage-secret-dev',
];

/** Tesseract language codes: `eng`, `chi_sim`, `script/Latin` is not allowed. */
const OCR_LANGUAGE_LIST_PATTERN = /^[a-z]{3}(_[a-z]+)?(\+[a-z]{3}(_[a-z]+)?)*$/;
const OCR_LANGUAGE_CSV_PATTERN =
  /^\s*[a-z]{3}(_[a-z]+)?\s*(,\s*[a-z]{3}(_[a-z]+)?\s*)*$/;

const MIME_TYPE_LIST_PATTERN =
  /^\s*[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+\s*(,\s*[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+\s*)*$/i;

/**
 * Validates process.env at boot. The application refuses to start when a
 * required variable is missing or malformed so misconfiguration is caught
 * early instead of surfacing as runtime errors.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(4310),
  API_PREFIX: Joi.string().default('api/v1'),
  TRUST_PROXY: Joi.boolean()
    .truthy('1', 'yes', 'on')
    .falsy('0', 'no', 'off')
    .default(false),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'log', 'debug', 'verbose')
    .optional(),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  TEST_DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .optional(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),
  THROTTLE_TTL: Joi.number().integer().min(1).default(60),

  SWAGGER_ENABLED: Joi.boolean()
    .truthy('1', 'yes', 'on')
    .falsy('0', 'no', 'off')
    .optional(),

  // --- Authentication (Phase 1) ---------------------------------------------
  JWT_ACCESS_SECRET: Joi.string()
    .min(32)
    .invalid(...PLACEHOLDER_SECRETS)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid(...DEV_ONLY_SECRETS),
    })
    .required(),
  JWT_REFRESH_SECRET: Joi.string()
    .min(32)
    .invalid(...PLACEHOLDER_SECRETS)
    .disallow(Joi.ref('JWT_ACCESS_SECRET'))
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid(...DEV_ONLY_SECRETS),
    })
    .required(),
  JWT_ACCESS_EXPIRES_IN: Joi.string().pattern(DURATION_PATTERN).default('15m'),
  JWT_REFRESH_EXPIRES_IN: Joi.string().pattern(DURATION_PATTERN).default('30d'),

  AUTH_LOGIN_RATE_LIMIT: Joi.number().integer().min(1).default(10),
  AUTH_LOGIN_RATE_WINDOW: Joi.number().integer().min(1).default(60),
  AUTH_REGISTER_RATE_LIMIT: Joi.number().integer().min(1).default(5),
  AUTH_REGISTER_RATE_WINDOW: Joi.number().integer().min(1).default(60),
  AUTH_REFRESH_RATE_LIMIT: Joi.number().integer().min(1).default(20),
  AUTH_REFRESH_RATE_WINDOW: Joi.number().integer().min(1).default(60),

  // --- Object storage (Phase 2) ----------------------------------------------
  STORAGE_PROVIDER: Joi.string().valid('s3').default('s3'),
  S3_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  S3_PUBLIC_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  S3_REGION: Joi.string().min(1).default('us-east-1'),
  // S3 bucket naming rules (lower-case, 3–63 chars, no underscores).
  S3_BUCKET: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .required(),
  TEST_S3_BUCKET: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .optional(),
  S3_ACCESS_KEY: Joi.string()
    .min(3)
    .invalid(...PLACEHOLDER_STORAGE_CREDENTIALS)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid(...DEV_ONLY_STORAGE_CREDENTIALS),
    })
    .required(),
  S3_SECRET_KEY: Joi.string()
    .min(8)
    .invalid(...PLACEHOLDER_STORAGE_CREDENTIALS)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid(...DEV_ONLY_STORAGE_CREDENTIALS),
    })
    .required(),
  S3_FORCE_PATH_STYLE: Joi.boolean()
    .truthy('1', 'yes', 'on')
    .falsy('0', 'no', 'off')
    .default(true),
  // Presigned URL lifetimes: at least 1 minute, at most 1 hour (upload) /
  // 15 minutes (download) so a leaked URL has a bounded window.
  S3_PRESIGNED_UPLOAD_EXPIRES_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(3600)
    .default(900),
  S3_PRESIGNED_DOWNLOAD_EXPIRES_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(900)
    .default(300),
  // Empty string is accepted (compose passes `${S3_AUTO_CREATE_BUCKET:-}`) and
  // means "use the NODE_ENV-based default" (see loadStorageConfig).
  S3_AUTO_CREATE_BUCKET: Joi.boolean()
    .truthy('1', 'yes', 'on')
    .falsy('0', 'no', 'off')
    .allow('')
    .optional(),

  // --- Documents (Phase 2) ---------------------------------------------------
  // 1 KiB .. 5 GiB (single-part presigned PUT limit).
  MAX_DOCUMENT_FILE_SIZE_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(5 * 1024 * 1024 * 1024)
    .default(52_428_800),
  ALLOWED_DOCUMENT_MIME_TYPES: Joi.string()
    .pattern(MIME_TYPE_LIST_PATTERN)
    .allow('')
    .optional(),
  DOCUMENT_PRESIGN_RATE_LIMIT: Joi.number().integer().min(1).default(30),
  DOCUMENT_PRESIGN_RATE_WINDOW: Joi.number().integer().min(1).default(60),

  // --- OCR (Phase 3) ---------------------------------------------------------
  OCR_ENABLED: optionalBoolean(),
  OCR_WORKER_ENABLED: optionalBoolean(),
  // Tesseract language list: codes joined by `+`, e.g. `ind+eng`.
  OCR_DEFAULT_LANGUAGE: Joi.string()
    .pattern(OCR_LANGUAGE_LIST_PATTERN)
    .allow('')
    .optional(),
  OCR_SUPPORTED_LANGUAGES: Joi.string()
    .pattern(OCR_LANGUAGE_CSV_PATTERN)
    .allow('')
    .optional(),
  OCR_MAX_LANGUAGES_PER_JOB: Joi.number().integer().min(1).max(5).default(3),
  OCR_QUEUE_NAME: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9_-]{1,63}$/)
    .default('docuai-ocr'),
  OCR_MAX_CONCURRENCY: Joi.number().integer().min(1).max(8).default(1),
  OCR_MAX_RETRIES: Joi.number().integer().min(0).max(10).default(2),
  OCR_RETRY_BACKOFF_MS: Joi.number().integer().min(100).default(5000),
  // 10 s .. 2 h per job, 5 s .. 15 min per page.
  OCR_JOB_TIMEOUT_MS: Joi.number()
    .integer()
    .min(10_000)
    .max(7_200_000)
    .default(600_000),
  OCR_PAGE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(5_000)
    .max(900_000)
    .default(60_000),
  OCR_STALE_JOB_MS: Joi.number().integer().min(10_000).optional(),
  OCR_RECONCILE_INTERVAL_MS: Joi.number().integer().min(5_000).default(60_000),
  OCR_MAX_FILE_SIZE_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(5 * 1024 * 1024 * 1024)
    .optional(),
  OCR_MAX_PDF_PAGES: Joi.number().integer().min(1).max(2000).default(100),
  OCR_RENDER_DPI: Joi.number().integer().min(72).max(600).default(150),
  OCR_MAX_RENDER_PIXELS: Joi.number()
    .integer()
    .min(250_000)
    .max(200_000_000)
    .default(20_000_000),
  OCR_MAX_IMAGE_PIXELS: Joi.number()
    .integer()
    .min(250_000)
    .max(200_000_000)
    .default(25_000_000),
  OCR_MAX_TEXT_PER_PAGE: Joi.number()
    .integer()
    .min(1000)
    .max(10_000_000)
    .default(200_000),
  OCR_MAX_TEXT_PER_DOCUMENT: Joi.number()
    .integer()
    .min(1000)
    .max(100_000_000)
    .default(2_000_000),
  OCR_MAX_ACTIVE_JOBS_PER_USER: Joi.number().integer().min(1).default(5),
  OCR_MAX_JOBS_PER_DOCUMENT: Joi.number().integer().min(1).default(20),
  OCR_NATIVE_TEXT_MIN_CHARS: Joi.number().integer().min(1).default(20),
  OCR_NATIVE_TEXT_MIN_ALNUM_RATIO: Joi.number().min(0).max(1).default(0.5),
  OCR_TESSERACT_PATH: Joi.string().allow('').optional(),
  OCR_POPPLER_PATH: Joi.string().allow('').optional(),
  OCR_TESSDATA_PREFIX: Joi.string().allow('').optional(),
  OCR_TMP_DIR: Joi.string().allow('').optional(),
  OCR_REQUEST_RATE_LIMIT: Joi.number().integer().min(1).default(10),
  OCR_REQUEST_RATE_WINDOW: Joi.number().integer().min(1).default(60),
}).unknown(true);

function optionalBoolean(): Joi.BooleanSchema {
  return Joi.boolean()
    .truthy('1', 'yes', 'on')
    .falsy('0', 'no', 'off')
    .allow('')
    .optional();
}
