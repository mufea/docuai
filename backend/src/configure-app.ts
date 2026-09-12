import {
  BadRequestException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import compression from 'compression';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import type { AppConfiguration } from './config/configuration';

export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<AppConfiguration>);
  const apiPrefix = config.get('apiPrefix', { infer: true }) ?? 'api/v1';
  const nodeEnv = config.get('nodeEnv', { infer: true }) ?? 'development';
  const corsOrigins = config.get('corsOrigins', { infer: true }) ?? [];

  app.setGlobalPrefix(apiPrefix);

  app.use(
    helmet({
      contentSecurityPolicy: nodeEnv === 'production',
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression());
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.enableCors({
    origin: resolveCorsOrigin(nodeEnv, corsOrigins),
    credentials: true,
    exposedHeaders: ['X-Request-ID'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      exceptionFactory: (errors) => {
        const messages = errors.flatMap((error) =>
          error.constraints ? Object.values(error.constraints) : [],
        );

        return new BadRequestException({
          code: 'VALIDATION_ERROR',
          message:
            messages.length > 0
              ? messages.join('; ')
              : 'Request validation failed',
        });
      },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.enableShutdownHooks();
}

function resolveCorsOrigin(
  nodeEnv: string,
  corsOrigins: string[],
): boolean | string[] {
  if (nodeEnv === 'production' && corsOrigins.includes('*')) {
    throw new Error('CORS_ORIGINS cannot use a wildcard in production');
  }

  if (corsOrigins.includes('*')) {
    return true;
  }

  return corsOrigins;
}
