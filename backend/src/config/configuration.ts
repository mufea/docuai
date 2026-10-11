export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  apiPrefix: string;
  trustProxy: boolean;
  corsOrigins: string[];
  logLevel: string;
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  throttle: {
    limit: number;
    ttlSeconds: number;
  };
  swagger: {
    enabled: boolean;
  };
  auth: AuthConfig;
  storage: StorageConfig;
  documents: DocumentsConfig;
  ocr: OcrConfig;
}

/** Phase 3 — OCR & text extraction. */
export interface OcrConfig {
  /** When false the OCR endpoints answer 503 and no worker starts. */
  enabled: boolean;
  /** Start the background worker in this process. */
  workerEnabled: boolean;
  /** Canonical default language list, e.g. `ind+eng`. */
  defaultLanguage: string;
  /** Language codes the deployment intends to offer (must be installed). */
  supportedLanguages: string[];
  /** Maximum number of `+`-combined languages per job. */
  maxLanguagesPerJob: number;
  queueName: string;
  /** Jobs processed simultaneously by one worker process. */
  concurrency: number;
  /** Processing attempts per job (1 = no automatic retry). */
  maxAttempts: number;
  /** Base delay for exponential retry backoff. */
  retryBackoffMs: number;
  /** Wall-clock budget for one whole job. */
  jobTimeoutMs: number;
  /** Budget for rendering + recognising one page. */
  pageTimeoutMs: number;
  /** PROCESSING jobs without a heartbeat for this long are considered interrupted. */
  staleJobMs: number;
  /** How often the worker reconciles database and queue state. */
  reconcileIntervalMs: number;
  limits: {
    maxFileSizeBytes: number;
    maxPdfPages: number;
    renderDpi: number;
    /** Upper bound for rendered page pixels (width × height). */
    maxRenderPixels: number;
    /** Upper bound for input image pixels (width × height). */
    maxImagePixels: number;
    maxTextPerPage: number;
    maxTextPerDocument: number;
    /** QUEUED + PROCESSING jobs one user may have at once. */
    maxActiveJobsPerUser: number;
    /** Total jobs (incl. retries/reprocessing) per document. */
    maxJobsPerDocument: number;
  };
  /** Native-text acceptance rule (see docs/ARCHITECTURE.md). */
  nativeText: {
    minChars: number;
    minAlphanumericRatio: number;
  };
  tools: {
    tesseractPath: string;
    /** Directory containing pdfinfo/pdftotext/pdftoppm; empty = PATH. */
    popplerPath: string | null;
    tessdataPrefix: string | null;
  };
  /** Directory for temporary files; empty = OS temp dir. */
  tmpDir: string | null;
  rateLimits: {
    request: RateLimitRule;
  };
}

export const DEFAULT_OCR_LANGUAGES = [
  'ind',
  'eng',
  'msa',
  'ara',
  'chi_sim',
  'jpn',
  'kor',
  'deu',
  'fra',
  'spa',
];

export interface RateLimitRule {
  /** Maximum number of requests per window, per client IP. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export interface AuthConfig {
  accessSecret: string;
  refreshSecret: string;
  /** Access token lifetime in seconds. */
  accessTtlSeconds: number;
  /** Refresh token lifetime in seconds. */
  refreshTtlSeconds: number;
  rateLimits: {
    login: RateLimitRule;
    register: RateLimitRule;
    refresh: RateLimitRule;
  };
}

/** Object-storage backends. Only `s3` (any S3-compatible API) exists in Phase 2. */
export type StorageProviderKind = 's3';

export interface S3StorageConfig {
  /** Endpoint the API uses for HEAD/DELETE calls. Empty = AWS default. */
  endpoint: string | null;
  /**
   * Endpoint embedded in presigned URLs handed to clients. Differs from
   * `endpoint` when the API reaches storage over an internal network (e.g.
   * `http://storage:9000` inside Docker vs `http://localhost:9000` for the
   * client). Empty = same as `endpoint`.
   */
  publicEndpoint: string | null;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

export interface StorageConfig {
  provider: StorageProviderKind;
  s3: S3StorageConfig;
  /** Lifetime of presigned PUT URLs in seconds. */
  uploadUrlTtlSeconds: number;
  /** Lifetime of presigned GET URLs in seconds. */
  downloadUrlTtlSeconds: number;
  /**
   * Create the (private) bucket at boot when it does not exist. Defaults to
   * true outside production so local/test environments are self-contained;
   * production deployments are expected to provision the bucket explicitly.
   */
  autoCreateBucket: boolean;
}

export interface DocumentsConfig {
  maxFileSizeBytes: number;
  /** Lower-cased MIME types accepted by the upload flow. */
  allowedMimeTypes: string[];
  rateLimits: {
    /** Applies to upload-url and download-url generation. */
    presign: RateLimitRule;
  };
}

export const DEFAULT_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
];

const DURATION_UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/**
 * Parses durations such as `900`, `15m`, `12h` or `30d` into seconds.
 * Throws on malformed values so misconfiguration fails at boot.
 */
export function parseDurationSeconds(value: string): number {
  const match = /^\s*(\d+)\s*([smhd])?\s*$/i.exec(value);
  if (!match) {
    throw new Error(
      `Invalid duration "${value}". Use a number of seconds or <n>[s|m|h|d].`,
    );
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = (match[2] ?? 's').toLowerCase();
  return amount * DURATION_UNITS[unit];
}

export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  return {
    accessSecret: env.JWT_ACCESS_SECRET ?? '',
    refreshSecret: env.JWT_REFRESH_SECRET ?? '',
    accessTtlSeconds: parseDurationSeconds(env.JWT_ACCESS_EXPIRES_IN ?? '15m'),
    refreshTtlSeconds: parseDurationSeconds(
      env.JWT_REFRESH_EXPIRES_IN ?? '30d',
    ),
    rateLimits: {
      login: {
        limit: toInt(env.AUTH_LOGIN_RATE_LIMIT, 10),
        windowSeconds: toInt(env.AUTH_LOGIN_RATE_WINDOW, 60),
      },
      register: {
        limit: toInt(env.AUTH_REGISTER_RATE_LIMIT, 5),
        windowSeconds: toInt(env.AUTH_REGISTER_RATE_WINDOW, 60),
      },
      refresh: {
        limit: toInt(env.AUTH_REFRESH_RATE_LIMIT, 20),
        windowSeconds: toInt(env.AUTH_REFRESH_RATE_WINDOW, 60),
      },
    },
  };
}

export function loadStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): StorageConfig {
  return {
    provider: (env.STORAGE_PROVIDER ?? 's3') as StorageProviderKind,
    s3: {
      endpoint: emptyToNull(env.S3_ENDPOINT),
      publicEndpoint: emptyToNull(env.S3_PUBLIC_ENDPOINT),
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? '',
      accessKey: env.S3_ACCESS_KEY ?? '',
      secretKey: env.S3_SECRET_KEY ?? '',
      forcePathStyle: toBool(env.S3_FORCE_PATH_STYLE, true),
    },
    uploadUrlTtlSeconds: toInt(env.S3_PRESIGNED_UPLOAD_EXPIRES_SECONDS, 900),
    downloadUrlTtlSeconds: toInt(
      env.S3_PRESIGNED_DOWNLOAD_EXPIRES_SECONDS,
      300,
    ),
    autoCreateBucket: toBool(
      env.S3_AUTO_CREATE_BUCKET,
      env.NODE_ENV !== 'production',
    ),
  };
}

export function loadDocumentsConfig(
  env: NodeJS.ProcessEnv = process.env,
): DocumentsConfig {
  return {
    maxFileSizeBytes: toInt(env.MAX_DOCUMENT_FILE_SIZE_BYTES, 52_428_800),
    allowedMimeTypes: parseMimeList(env.ALLOWED_DOCUMENT_MIME_TYPES),
    rateLimits: {
      presign: {
        limit: toInt(env.DOCUMENT_PRESIGN_RATE_LIMIT, 30),
        windowSeconds: toInt(env.DOCUMENT_PRESIGN_RATE_WINDOW, 60),
      },
    },
  };
}

export function loadOcrConfig(env: NodeJS.ProcessEnv = process.env): OcrConfig {
  const jobTimeoutMs = toInt(env.OCR_JOB_TIMEOUT_MS, 600_000);
  return {
    enabled: toBool(env.OCR_ENABLED, true),
    workerEnabled: toBool(env.OCR_WORKER_ENABLED, true),
    defaultLanguage: env.OCR_DEFAULT_LANGUAGE?.trim() || 'ind+eng',
    supportedLanguages: parseCodeList(
      env.OCR_SUPPORTED_LANGUAGES,
      DEFAULT_OCR_LANGUAGES,
    ),
    maxLanguagesPerJob: toInt(env.OCR_MAX_LANGUAGES_PER_JOB, 3),
    queueName: env.OCR_QUEUE_NAME?.trim() || 'docuai-ocr',
    concurrency: toInt(env.OCR_MAX_CONCURRENCY, 1),
    maxAttempts: toInt(env.OCR_MAX_RETRIES, 2) + 1,
    retryBackoffMs: toInt(env.OCR_RETRY_BACKOFF_MS, 5_000),
    jobTimeoutMs,
    pageTimeoutMs: toInt(env.OCR_PAGE_TIMEOUT_MS, 60_000),
    // The worker heartbeats at least every 10 s while a job runs (independent
    // of page duration), so two minutes of silence reliably means it died.
    staleJobMs: toInt(env.OCR_STALE_JOB_MS, 120_000),
    reconcileIntervalMs: toInt(env.OCR_RECONCILE_INTERVAL_MS, 60_000),
    limits: {
      maxFileSizeBytes: toInt(
        env.OCR_MAX_FILE_SIZE_BYTES,
        toInt(env.MAX_DOCUMENT_FILE_SIZE_BYTES, 52_428_800),
      ),
      maxPdfPages: toInt(env.OCR_MAX_PDF_PAGES, 100),
      renderDpi: toInt(env.OCR_RENDER_DPI, 150),
      maxRenderPixels: toInt(env.OCR_MAX_RENDER_PIXELS, 20_000_000),
      maxImagePixels: toInt(env.OCR_MAX_IMAGE_PIXELS, 25_000_000),
      maxTextPerPage: toInt(env.OCR_MAX_TEXT_PER_PAGE, 200_000),
      maxTextPerDocument: toInt(env.OCR_MAX_TEXT_PER_DOCUMENT, 2_000_000),
      maxActiveJobsPerUser: toInt(env.OCR_MAX_ACTIVE_JOBS_PER_USER, 5),
      maxJobsPerDocument: toInt(env.OCR_MAX_JOBS_PER_DOCUMENT, 20),
    },
    nativeText: {
      minChars: toInt(env.OCR_NATIVE_TEXT_MIN_CHARS, 20),
      minAlphanumericRatio: toFloat(env.OCR_NATIVE_TEXT_MIN_ALNUM_RATIO, 0.5),
    },
    tools: {
      tesseractPath: env.OCR_TESSERACT_PATH?.trim() || 'tesseract',
      popplerPath: emptyToNull(env.OCR_POPPLER_PATH),
      tessdataPrefix: emptyToNull(env.OCR_TESSDATA_PREFIX),
    },
    tmpDir: emptyToNull(env.OCR_TMP_DIR),
    rateLimits: {
      request: {
        limit: toInt(env.OCR_REQUEST_RATE_LIMIT, 10),
        windowSeconds: toInt(env.OCR_REQUEST_RATE_WINDOW, 60),
      },
    },
  };
}

function parseCodeList(
  value: string | undefined,
  fallback: string[],
): string[] {
  const parsed = (value ?? '')
    .split(',')
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? [...new Set(parsed)] : fallback;
}

function toFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseMimeList(value: string | undefined): string[] {
  const parsed = (value ?? '')
    .split(',')
    .map((type) => type.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? [...new Set(parsed)] : DEFAULT_ALLOWED_MIME_TYPES;
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim();
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['nodeEnv'];
  return {
    nodeEnv,
    port: toInt(env.PORT, 4310),
    apiPrefix: env.API_PREFIX ?? 'api/v1',
    trustProxy: toBool(env.TRUST_PROXY, false),
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    logLevel: env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'log' : 'debug'),
    database: {
      url: env.DATABASE_URL ?? '',
    },
    redis: {
      url: env.REDIS_URL ?? 'redis://localhost:6379/0',
    },
    throttle: {
      limit: toInt(env.THROTTLE_LIMIT, 100),
      ttlSeconds: toInt(env.THROTTLE_TTL, 60),
    },
    swagger: {
      enabled: toBool(env.SWAGGER_ENABLED, nodeEnv !== 'production'),
    },
    auth: loadAuthConfig(env),
    storage: loadStorageConfig(env),
    documents: loadDocumentsConfig(env),
    ocr: loadOcrConfig(env),
  };
}

export default loadConfiguration;
