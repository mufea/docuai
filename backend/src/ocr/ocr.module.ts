import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { UsersModule } from '../users/users.module';
import { OcrExtractionService } from './ocr-extraction.service';
import { OcrHealthService } from './ocr-health.service';
import { OcrJobService } from './ocr-job.service';
import { OcrLanguagesService } from './ocr-languages.service';
import { OcrQueueService } from './ocr-queue.service';
import { OcrWorkerService } from './ocr-worker.service';
import { OcrController } from './ocr.controller';
import { OcrService } from './ocr.service';
import { OcrProvider } from './providers/ocr-provider.interface';
import { TesseractOcrProvider } from './providers/tesseract-ocr.provider';
import { PopplerService } from './tools/poppler.service';

/**
 * Phase 3 — OCR & text extraction. The engine is bound through the
 * `OcrProvider` abstraction; swap `TesseractOcrProvider` here to use another
 * engine without touching jobs, worker or API.
 */
@Module({
  imports: [UsersModule, DocumentsModule],
  controllers: [OcrController],
  providers: [
    { provide: OcrProvider, useClass: TesseractOcrProvider },
    PopplerService,
    OcrLanguagesService,
    OcrExtractionService,
    OcrJobService,
    OcrQueueService,
    OcrWorkerService,
    OcrService,
    OcrHealthService,
  ],
  exports: [OcrHealthService, OcrWorkerService, OcrJobService, OcrQueueService],
})
export class OcrModule {}
