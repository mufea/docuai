import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfiguration } from './config/configuration';
import { configureApp } from './configure-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);

  const config = app.get(ConfigService<AppConfiguration>);
  const port = config.get('appPort', { infer: true }) ?? 3000;
  const apiPrefix = config.get('apiPrefix', { infer: true }) ?? 'api/v1';
  const appName = config.get('appName', { infer: true }) ?? 'DocuAI';

  await app.listen(port, '0.0.0.0');

  const logger = app.get(Logger);
  logger.log(`${appName} API listening on port ${port} (${apiPrefix})`);
}

void bootstrap();
