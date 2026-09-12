import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApplication } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApplication(app);
  const config = app.get(ConfigService);
  await app.listen(config.get<number>('port', 3000), '0.0.0.0');
}

void bootstrap();
