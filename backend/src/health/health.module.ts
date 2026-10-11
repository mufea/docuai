import { Module } from '@nestjs/common';
import { OcrModule } from '../ocr/ocr.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [OcrModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
