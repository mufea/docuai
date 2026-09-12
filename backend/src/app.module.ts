import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { resolveRequestId } from './common/utils/request-id.util';
import configuration, { type AppConfiguration } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnv,
      envFilePath: ['.env'],
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration>) => ({
        pinoHttp: {
          level: config.get('logLevel', { infer: true }) ?? 'info',
          genReqId: (req) =>
            resolveRequestId(
              req.headers['x-request-id'] ?? req.headers['X-Request-ID'],
              'requestId' in req && typeof req.requestId === 'string'
                ? req.requestId
                : typeof req.id === 'string'
                  ? req.id
                  : undefined,
            ),
          customProps: (req) => ({
            requestId:
              'requestId' in req && typeof req.requestId === 'string'
                ? req.requestId
                : req.id,
            service: 'docuai-api',
          }),
          serializers: {
            req: (req) => ({
              id: req.id,
              method: req.method,
              url: req.url,
            }),
            res: (res) => ({
              statusCode: res.statusCode,
            }),
          },
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
              'req.headers["x-auth-token"]',
              '*.password',
              '*.secret',
              '*.token',
              '*.accessToken',
              '*.refreshToken',
              '*.DATABASE_URL',
              '*.REDIS_URL',
              '*.JWT_ACCESS_SECRET',
              '*.JWT_REFRESH_SECRET',
            ],
            censor: '[Redacted]',
          },
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration>) => {
        const ttlSeconds = config.get('rateLimitTtl', { infer: true }) ?? 60;
        const limit = config.get('rateLimitLimit', { infer: true }) ?? 100;

        return {
          throttlers: [
            {
              ttl: ttlSeconds * 1000,
              limit,
            },
          ],
        };
      },
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}');
  }
}
