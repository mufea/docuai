const NODE_ENVS = ['development', 'production', 'test'] as const;

const REQUIRED_KEYS = [
  'NODE_ENV',
  'APP_PORT',
  'DATABASE_URL',
  'REDIS_URL',
] as const;

function readString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const missing = REQUIRED_KEYS.filter((key) => {
    const value = config[key];
    return (
      value === undefined || value === null || readString(value).trim() === ''
    );
  });

  if (missing.length > 0) {
    throw new Error(
      `Invalid configuration: missing required variable(s): ${missing.join(', ')}`,
    );
  }

  const nodeEnv = readString(config.NODE_ENV);
  if (!NODE_ENVS.includes(nodeEnv as (typeof NODE_ENVS)[number])) {
    throw new Error(
      `Invalid configuration: NODE_ENV must be one of ${NODE_ENVS.join(', ')}`,
    );
  }

  const port = Number(config.APP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      'Invalid configuration: APP_PORT must be an integer between 1 and 65535',
    );
  }

  const databaseUrl = readString(config.DATABASE_URL);
  if (
    !databaseUrl.startsWith('postgresql://') &&
    !databaseUrl.startsWith('postgres://')
  ) {
    throw new Error(
      'Invalid configuration: DATABASE_URL must be a PostgreSQL connection string',
    );
  }

  const redisUrl = readString(config.REDIS_URL);
  if (!redisUrl.startsWith('redis://') && !redisUrl.startsWith('rediss://')) {
    throw new Error(
      'Invalid configuration: REDIS_URL must be a Redis connection string',
    );
  }

  const corsOrigins = readString(config.CORS_ORIGINS)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (nodeEnv === 'production' && corsOrigins.includes('*')) {
    throw new Error(
      'Invalid configuration: CORS_ORIGINS cannot use a wildcard in production',
    );
  }

  return config;
}
