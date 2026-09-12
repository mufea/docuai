export interface AppConfiguration {
  nodeEnv: string;
  appName: string;
  port: number;
  apiPrefix: string;
  databaseUrl: string;
  redisUrl: string;
  corsOrigins: string[];
  rateLimitTtlSeconds: number;
  rateLimitLimit: number;
}

export const configuration = (): AppConfiguration => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  appName: process.env.APP_NAME ?? 'DocuAI',
  port: Number(process.env.APP_PORT ?? 3000),
  apiPrefix: process.env.API_PREFIX ?? 'api/v1',
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  rateLimitTtlSeconds: Number(process.env.RATE_LIMIT_TTL ?? 60),
  rateLimitLimit: Number(process.env.RATE_LIMIT_LIMIT ?? 100),
});
