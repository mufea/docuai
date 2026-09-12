export interface AppConfiguration {
  nodeEnv: 'development' | 'production' | 'test';
  appName: string;
  appPort: number;
  apiPrefix: string;
  databaseUrl: string;
  redisUrl: string;
  logLevel: string;
  corsOrigins: string[];
  rateLimitTtl: number;
  rateLimitLimit: number;
}

export default (): AppConfiguration => ({
  nodeEnv: (process.env.NODE_ENV ??
    'development') as AppConfiguration['nodeEnv'],
  appName: process.env.APP_NAME ?? 'DocuAI',
  appPort: parseInt(process.env.APP_PORT ?? '3000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api/v1',
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  rateLimitTtl: parseInt(process.env.RATE_LIMIT_TTL ?? '60', 10),
  rateLimitLimit: parseInt(process.env.RATE_LIMIT_LIMIT ?? '100', 10),
});
