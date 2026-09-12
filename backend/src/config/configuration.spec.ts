import {
  loadAuthConfig,
  loadConfiguration,
  parseDurationSeconds,
} from './configuration';
import { envValidationSchema } from './env.validation';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
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
});
