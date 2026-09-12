import { LogLevel, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SWAGGER_PATH, configureApp } from './app.setup';
import { AppConfig } from './config/configuration';

const LOG_LEVELS: LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

function resolveLogLevels(level: string): LogLevel[] {
  const index = LOG_LEVELS.indexOf(level as LogLevel);
  return LOG_LEVELS.slice(0, (index === -1 ? 3 : index) + 1);
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const configService = app.get(ConfigService<AppConfig, true>);

  app.useLogger(
    resolveLogLevels(configService.get('logLevel', { infer: true })),
  );
  configureApp(app);

  const port = configService.get('port', { infer: true });
  const prefix = configService.get('apiPrefix', { infer: true });
  await app.listen(port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`DocuAI API listening on http://0.0.0.0:${port}/${prefix}`);
  if (configService.get('swagger', { infer: true }).enabled) {
    logger.log(
      `OpenAPI docs available at http://0.0.0.0:${port}/${prefix}/${SWAGGER_PATH}`,
    );
  }
}

void bootstrap();
