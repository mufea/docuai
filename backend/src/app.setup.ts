import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import { AppConfig } from './config/configuration';

export const SWAGGER_PATH = 'docs';

/**
 * Applies the cross-cutting HTTP configuration (prefix, security headers,
 * request IDs, validation, envelopes). Shared by `main.ts` and the e2e tests
 * so tests exercise exactly the same pipeline as production.
 */
export function configureApp(app: INestApplication): INestApplication {
  const configService = app.get(ConfigService<AppConfig, true>);
  const expressApp = app as NestExpressApplication;

  expressApp.set(
    'trust proxy',
    configService.get('trustProxy', { infer: true }),
  );
  expressApp.disable('x-powered-by');

  app.setGlobalPrefix(configService.get('apiPrefix', { infer: true }));
  app.use(helmet());
  app.use(requestIdMiddleware);

  const corsOrigins = configService.get('corsOrigins', { infer: true });
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      forbidUnknownValues: true,
      stopAtFirstError: false,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.enableShutdownHooks();

  if (configService.get('swagger', { infer: true }).enabled) {
    setupSwagger(app);
  }

  return app;
}

function setupSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('DocuAI API')
      .setDescription(
        'DocuAI backend API. All responses use the standard envelope ' +
          '`{ success, data, message, requestId }` on success and ' +
          '`{ success, data: null, code, message, requestId }` on error.',
      )
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'bearer',
      )
      .build(),
  );
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    useGlobalPrefix: true,
    swaggerOptions: { persistAuthorization: true },
  });
}
