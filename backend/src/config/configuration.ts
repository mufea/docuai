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
}

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
  };
}

export default loadConfiguration;
