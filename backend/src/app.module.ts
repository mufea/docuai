import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, seconds } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { AppConfig, loadConfiguration } from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { RedisService } from './redis/redis.service';
import { SecurityModule } from './security/security.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [loadConfiguration],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
      envFilePath: process.env.NODE_ENV === 'test' ? [] : ['.env'],
    }),
    PrismaModule,
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, RedisService],
      useFactory: (
        configService: ConfigService<AppConfig, true>,
        redisService: RedisService,
      ) => {
        const throttle = configService.get('throttle', { infer: true });
        return {
          throttlers: [
            {
              name: 'default',
              ttl: seconds(throttle.ttlSeconds),
              limit: throttle.limit,
            },
          ],
          storage: new ThrottlerStorageRedisService(redisService.getClient()),
        };
      },
    }),
    SecurityModule,
    HealthModule,
    UsersModule,
    AuthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
