import { validateEnv } from './env.validation';

const valid = {
  NODE_ENV: 'development',
  APP_PORT: '3000',
  DATABASE_URL:
    'postgresql://docuai:docuai_dev_password@postgres:5432/docuai?schema=public',
  REDIS_URL: 'redis://redis:6379',
};

describe('validateEnv', () => {
  it('accepts a valid configuration', () => {
    expect(() => validateEnv(valid)).not.toThrow();
  });

  it('fails fast when required values are missing', () => {
    expect(() => validateEnv({ ...valid, DATABASE_URL: '' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });

  it('rejects a non-integer APP_PORT', () => {
    expect(() => validateEnv({ ...valid, APP_PORT: 'abc' })).toThrow(
      /APP_PORT/,
    );
  });

  it('rejects wildcard CORS in production', () => {
    expect(() =>
      validateEnv({
        ...valid,
        NODE_ENV: 'production',
        CORS_ORIGINS: '*',
      }),
    ).toThrow(/wildcard/);
  });
});
