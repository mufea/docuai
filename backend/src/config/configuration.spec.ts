import {
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_OCR_LANGUAGES,
  loadAuthConfig,
  loadConfiguration,
  loadDocumentsConfig,
  loadOcrConfig,
  loadStorageConfig,
  parseDurationSeconds,
} from './configuration';
import { envValidationSchema } from './env.validation';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  S3_BUCKET: 'docuai-private',
  S3_ACCESS_KEY: 'test-access-key',
  S3_SECRET_KEY: 'test-secret-key-value',
};

describe('parseDurationSeconds', () => {
  it.each([
    ['900', 900],
    ['15m', 900],
    ['12h', 43200],
    ['30d', 2592000],
    ['45s', 45],
    [' 2M ', 120],
  ])('parses %s', (input, expected) => {
    expect(parseDurationSeconds(input)).toBe(expected);
  });

  it('throws on malformed durations', () => {
    expect(() => parseDurationSeconds('15 minutes')).toThrow();
    expect(() => parseDurationSeconds('')).toThrow();
    expect(() => parseDurationSeconds('-5m')).toThrow();
  });
});

describe('loadAuthConfig', () => {
  it('applies the documented defaults', () => {
    const auth = loadAuthConfig(BASE_ENV);

    expect(auth.accessTtlSeconds).toBe(900);
    expect(auth.refreshTtlSeconds).toBe(30 * 86400);
    expect(auth.rateLimits).toEqual({
      login: { limit: 10, windowSeconds: 60 },
      register: { limit: 5, windowSeconds: 60 },
      refresh: { limit: 20, windowSeconds: 60 },
    });
  });

  it('reads overrides', () => {
    const auth = loadAuthConfig({
      ...BASE_ENV,
      JWT_ACCESS_EXPIRES_IN: '5m',
      JWT_REFRESH_EXPIRES_IN: '7d',
      AUTH_LOGIN_RATE_LIMIT: '3',
      AUTH_LOGIN_RATE_WINDOW: '30',
    });

    expect(auth.accessTtlSeconds).toBe(300);
    expect(auth.refreshTtlSeconds).toBe(7 * 86400);
    expect(auth.rateLimits.login).toEqual({ limit: 3, windowSeconds: 30 });
  });
});

describe('configuration', () => {
  it('applies defaults when optional variables are absent', () => {
    const config = loadConfiguration({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379/0',
    });

    expect(config.port).toBe(4310);
    expect(config.apiPrefix).toBe('api/v1');
    expect(config.trustProxy).toBe(false);
    expect(config.corsOrigins).toEqual([]);
    expect(config.throttle).toEqual({ limit: 100, ttlSeconds: 60 });
  });

  it('parses provided variables', () => {
    const config = loadConfiguration({
      NODE_ENV: 'production',
      PORT: '8081',
      TRUST_PROXY: 'true',
      CORS_ORIGINS: 'https://a.example, https://b.example',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379/0',
      THROTTLE_LIMIT: '20',
      THROTTLE_TTL: '30',
    });

    expect(config.nodeEnv).toBe('production');
    expect(config.port).toBe(8081);
    expect(config.trustProxy).toBe(true);
    expect(config.corsOrigins).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(config.throttle).toEqual({ limit: 20, ttlSeconds: 30 });
    expect(config.swagger.enabled).toBe(false);
  });
});

describe('envValidationSchema', () => {
  it('rejects a missing DATABASE_URL', () => {
    const { error } = envValidationSchema.validate(
      { REDIS_URL: 'redis://localhost:6379' },
      { abortEarly: false },
    );

    expect(error?.details.map((d) => d.path.join('.'))).toContain(
      'DATABASE_URL',
    );
  });

  it('rejects an invalid REDIS_URL scheme', () => {
    const { error } = envValidationSchema.validate({
      ...BASE_ENV,
      REDIS_URL: 'http://localhost:6379',
    });

    expect(error).toBeDefined();
  });

  it('accepts a complete auth configuration', () => {
    const { error } = envValidationSchema.validate(BASE_ENV);

    expect(error).toBeUndefined();
  });

  it('rejects short, placeholder or identical JWT secrets', () => {
    expect(
      envValidationSchema.validate({ ...BASE_ENV, JWT_ACCESS_SECRET: 'short' })
        .error,
    ).toBeDefined();
    expect(
      envValidationSchema.validate({
        ...BASE_ENV,
        JWT_ACCESS_SECRET: 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET',
      }).error,
    ).toBeDefined();
    expect(
      envValidationSchema.validate({
        ...BASE_ENV,
        JWT_REFRESH_SECRET: BASE_ENV.JWT_ACCESS_SECRET,
      }).error,
    ).toBeDefined();
  });

  it('refuses the docker-compose development secrets in production', () => {
    const env = {
      ...BASE_ENV,
      JWT_ACCESS_SECRET:
        'dev-only-insecure-access-secret-do-not-use-in-production',
    };

    expect(envValidationSchema.validate(env).error).toBeUndefined();
    expect(
      envValidationSchema.validate({ ...env, NODE_ENV: 'production' }).error,
    ).toBeDefined();
  });

  it('rejects malformed token lifetimes', () => {
    const { error } = envValidationSchema.validate({
      ...BASE_ENV,
      JWT_ACCESS_EXPIRES_IN: 'fifteen minutes',
    });

    expect(error).toBeDefined();
  });

  it('requires storage bucket and credentials', () => {
    const { error } = envValidationSchema.validate(
      {
        ...BASE_ENV,
        S3_BUCKET: undefined,
        S3_ACCESS_KEY: undefined,
        S3_SECRET_KEY: undefined,
      },
      { abortEarly: false },
    );

    const paths = error?.details.map((d) => d.path.join('.')) ?? [];
    expect(paths).toEqual(
      expect.arrayContaining(['S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']),
    );
  });

  it('rejects placeholder storage credentials and invalid bucket names', () => {
    expect(
      envValidationSchema.validate({ ...BASE_ENV, S3_ACCESS_KEY: 'CHANGE_ME' })
        .error,
    ).toBeDefined();
    expect(
      envValidationSchema.validate({ ...BASE_ENV, S3_BUCKET: 'Has_Upper' })
        .error,
    ).toBeDefined();
  });

  it('refuses the docker-compose storage credentials in production', () => {
    const env = {
      ...BASE_ENV,
      S3_ACCESS_KEY: 'docuai-storage',
      S3_SECRET_KEY: 'docuai-storage-secret-dev',
    };

    expect(envValidationSchema.validate(env).error).toBeUndefined();
    expect(
      envValidationSchema.validate({ ...env, NODE_ENV: 'production' }).error,
    ).toBeDefined();
  });

  it('bounds presigned URL lifetimes and file size', () => {
    expect(
      envValidationSchema.validate({
        ...BASE_ENV,
        S3_PRESIGNED_DOWNLOAD_EXPIRES_SECONDS: '7200',
      }).error,
    ).toBeDefined();
    expect(
      envValidationSchema.validate({
        ...BASE_ENV,
        MAX_DOCUMENT_FILE_SIZE_BYTES: '10',
      }).error,
    ).toBeDefined();
    expect(
      envValidationSchema.validate({
        ...BASE_ENV,
        ALLOWED_DOCUMENT_MIME_TYPES: 'application/pdf, not-a-mime',
      }).error,
    ).toBeDefined();
  });
});

describe('loadStorageConfig / loadDocumentsConfig', () => {
  it('applies the documented defaults', () => {
    const storage = loadStorageConfig(BASE_ENV);
    const documents = loadDocumentsConfig(BASE_ENV);

    expect(storage.provider).toBe('s3');
    expect(storage.s3).toEqual({
      endpoint: null,
      publicEndpoint: null,
      region: 'us-east-1',
      bucket: 'docuai-private',
      accessKey: 'test-access-key',
      secretKey: 'test-secret-key-value',
      forcePathStyle: true,
    });
    expect(storage.uploadUrlTtlSeconds).toBe(900);
    expect(storage.downloadUrlTtlSeconds).toBe(300);
    expect(storage.autoCreateBucket).toBe(true);
    expect(documents.maxFileSizeBytes).toBe(52_428_800);
    expect(documents.allowedMimeTypes).toEqual(DEFAULT_ALLOWED_MIME_TYPES);
    expect(documents.rateLimits.presign).toEqual({
      limit: 30,
      windowSeconds: 60,
    });
  });

  it('normalises the MIME allowlist and reads overrides', () => {
    const documents = loadDocumentsConfig({
      ...BASE_ENV,
      ALLOWED_DOCUMENT_MIME_TYPES: ' Application/PDF ,image/png,image/png',
      MAX_DOCUMENT_FILE_SIZE_BYTES: '1048576',
    });
    const storage = loadStorageConfig({
      ...BASE_ENV,
      S3_ENDPOINT: 'http://storage:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_FORCE_PATH_STYLE: 'false',
      S3_PRESIGNED_UPLOAD_EXPIRES_SECONDS: '120',
    });

    expect(documents.allowedMimeTypes).toEqual([
      'application/pdf',
      'image/png',
    ]);
    expect(documents.maxFileSizeBytes).toBe(1_048_576);
    expect(storage.s3.endpoint).toBe('http://storage:9000');
    expect(storage.s3.publicEndpoint).toBe('http://localhost:9000');
    expect(storage.s3.forcePathStyle).toBe(false);
    expect(storage.uploadUrlTtlSeconds).toBe(120);
  });

  it('never auto-creates the bucket in production unless opted in', () => {
    expect(
      loadStorageConfig({ ...BASE_ENV, NODE_ENV: 'production' })
        .autoCreateBucket,
    ).toBe(false);
    expect(
      loadStorageConfig({
        ...BASE_ENV,
        NODE_ENV: 'production',
        S3_AUTO_CREATE_BUCKET: 'true',
      }).autoCreateBucket,
    ).toBe(true);
    expect(
      loadStorageConfig({ ...BASE_ENV, S3_AUTO_CREATE_BUCKET: 'false' })
        .autoCreateBucket,
    ).toBe(false);
  });
});

describe('loadOcrConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadOcrConfig({});
    expect(config.enabled).toBe(true);
    expect(config.workerEnabled).toBe(true);
    expect(config.defaultLanguage).toBe('ind+eng');
    expect(config.supportedLanguages).toEqual(DEFAULT_OCR_LANGUAGES);
    expect(config.queueName).toBe('docuai-ocr');
    expect(config.concurrency).toBe(1);
    // OCR_MAX_RETRIES=2 → three attempts in total.
    expect(config.maxAttempts).toBe(3);
    expect(config.jobTimeoutMs).toBe(600_000);
    expect(config.pageTimeoutMs).toBe(60_000);
    expect(config.staleJobMs).toBe(120_000);
    expect(config.limits).toEqual({
      maxFileSizeBytes: 52_428_800,
      maxPdfPages: 100,
      renderDpi: 150,
      maxRenderPixels: 20_000_000,
      maxImagePixels: 25_000_000,
      maxTextPerPage: 200_000,
      maxTextPerDocument: 2_000_000,
      maxActiveJobsPerUser: 5,
      maxJobsPerDocument: 20,
    });
    expect(config.nativeText).toEqual({
      minChars: 20,
      minAlphanumericRatio: 0.5,
    });
    expect(config.tools).toEqual({
      tesseractPath: 'tesseract',
      popplerPath: null,
      tessdataPrefix: null,
    });
    expect(config.rateLimits.request).toEqual({ limit: 10, windowSeconds: 60 });
  });

  it('reads overrides and inherits the Phase 2 file-size limit', () => {
    const config = loadOcrConfig({
      OCR_ENABLED: 'false',
      OCR_WORKER_ENABLED: '0',
      OCR_DEFAULT_LANGUAGE: 'eng',
      OCR_SUPPORTED_LANGUAGES: 'eng, deu,eng',
      OCR_MAX_RETRIES: '0',
      OCR_MAX_PDF_PAGES: '10',
      MAX_DOCUMENT_FILE_SIZE_BYTES: '1048576',
      OCR_POPPLER_PATH: '/opt/poppler/bin',
    });
    expect(config.enabled).toBe(false);
    expect(config.workerEnabled).toBe(false);
    expect(config.defaultLanguage).toBe('eng');
    expect(config.supportedLanguages).toEqual(['eng', 'deu']);
    expect(config.maxAttempts).toBe(1);
    expect(config.limits.maxPdfPages).toBe(10);
    expect(config.limits.maxFileSizeBytes).toBe(1_048_576);
    expect(config.tools.popplerPath).toBe('/opt/poppler/bin');
    expect(loadConfiguration({ ...BASE_ENV }).ocr.enabled).toBe(true);
  });
});

describe('envValidationSchema (OCR)', () => {
  it('accepts the documented OCR configuration', () => {
    const { error } = envValidationSchema.validate({
      ...BASE_ENV,
      OCR_ENABLED: 'true',
      OCR_DEFAULT_LANGUAGE: 'ind+eng',
      OCR_SUPPORTED_LANGUAGES: 'ind,eng,msa,ara,chi_sim,jpn,kor,deu,fra,spa',
      OCR_MAX_PDF_PAGES: '100',
      OCR_RENDER_DPI: '150',
      OCR_MAX_CONCURRENCY: '1',
      OCR_JOB_TIMEOUT_MS: '120000',
      OCR_MAX_RETRIES: '2',
      OCR_QUEUE_NAME: 'docuai-ocr',
    });
    expect(error).toBeUndefined();
  });

  it.each([
    ['OCR_DEFAULT_LANGUAGE', 'eng;rm -rf /'],
    ['OCR_DEFAULT_LANGUAGE', '../eng'],
    ['OCR_SUPPORTED_LANGUAGES', 'eng,en'],
    ['OCR_MAX_PDF_PAGES', '0'],
    ['OCR_MAX_PDF_PAGES', '5000'],
    ['OCR_RENDER_DPI', '30'],
    ['OCR_RENDER_DPI', '1200'],
    ['OCR_MAX_CONCURRENCY', '0'],
    ['OCR_MAX_CONCURRENCY', '50'],
    ['OCR_MAX_RETRIES', '-1'],
    ['OCR_JOB_TIMEOUT_MS', '100'],
    ['OCR_PAGE_TIMEOUT_MS', '1'],
    ['OCR_MAX_TEXT_PER_PAGE', '10'],
    ['OCR_QUEUE_NAME', 'has space'],
    ['OCR_NATIVE_TEXT_MIN_ALNUM_RATIO', '1.5'],
    ['OCR_ENABLED', 'maybe'],
  ])('rejects %s=%s', (key, value) => {
    const { error } = envValidationSchema.validate({
      ...BASE_ENV,
      [key]: value,
    });
    expect(error?.details.map((d) => d.path.join('.'))).toContain(key);
  });
});
