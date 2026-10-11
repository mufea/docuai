import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  OcrExtractionMethod,
  OcrJob,
  OcrJobStatus,
  OcrPage,
  OcrPageStatus,
} from '@prisma/client';

/**
 * The only OCR job shape that leaves the API. `userId`, `heartbeatAt` and the
 * internal error message detail are never exposed.
 */
export class OcrJobDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  documentId!: string;

  @ApiProperty({ enum: OcrJobStatus })
  status!: OcrJobStatus;

  @ApiProperty({ example: 'ind+eng' })
  language!: string;

  @ApiPropertyOptional({ enum: OcrExtractionMethod, nullable: true })
  extractionMethod!: OcrExtractionMethod | null;

  @ApiPropertyOptional({ nullable: true })
  totalPages!: number | null;

  @ApiProperty({ description: 'Pages attempted (completed, empty or failed).' })
  processedPages!: number;

  @ApiProperty()
  failedPages!: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'processedPages / totalPages as a percentage (0–100); null until the page count is known.',
  })
  progress!: number | null;

  @ApiProperty()
  attemptCount!: number;

  @ApiProperty()
  maxAttempts!: number;

  @ApiPropertyOptional({ nullable: true, example: 'OCR_PROCESSING_TIMEOUT' })
  errorCode!: string | null;

  @ApiPropertyOptional({ nullable: true })
  errorMessage!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  startedAt!: Date | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  completedAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class OcrPageDto {
  @ApiProperty({ minimum: 1 })
  pageNumber!: number;

  @ApiProperty({ enum: OcrPageStatus })
  status!: OcrPageStatus;

  @ApiPropertyOptional({ enum: ['NATIVE_TEXT', 'OCR'], nullable: true })
  method!: OcrExtractionMethod | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Null when the page FAILED.',
  })
  text!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 92.5,
    description:
      'Mean OCR word confidence 0–100; null for native text or when no word was recognised.',
  })
  confidence!: number | null;

  @ApiProperty()
  charCount!: number;

  @ApiProperty({
    description: 'True when text was cut at the configured limit.',
  })
  truncated!: boolean;

  @ApiPropertyOptional({ nullable: true })
  errorCode!: string | null;
}

export class OcrResultsDto {
  @ApiProperty({ format: 'uuid' })
  jobId!: string;

  @ApiProperty({ format: 'uuid' })
  documentId!: string;

  @ApiProperty({ enum: OcrJobStatus })
  status!: OcrJobStatus;

  @ApiProperty({ example: 'ind+eng' })
  language!: string;

  @ApiPropertyOptional({ enum: OcrExtractionMethod, nullable: true })
  extractionMethod!: OcrExtractionMethod | null;

  @ApiPropertyOptional({ nullable: true })
  totalPages!: number | null;

  @ApiPropertyOptional({ nullable: true })
  errorCode!: string | null;

  @ApiProperty({ type: [OcrPageDto] })
  pages!: OcrPageDto[];

  @ApiProperty({
    example: { page: 1, limit: 10, total: 3, totalPages: 1 },
    description: 'Pagination over page results (not document pages).',
  })
  pagination!: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export function toOcrJobDto(job: OcrJob): OcrJobDto {
  return {
    id: job.id,
    documentId: job.documentId,
    status: job.status,
    language: job.language,
    extractionMethod: job.extractionMethod,
    totalPages: job.totalPages,
    processedPages: job.processedPages,
    failedPages: job.failedPages,
    progress:
      job.totalPages && job.totalPages > 0
        ? Math.min(
            100,
            Math.round((job.processedPages / job.totalPages) * 1000) / 10,
          )
        : null,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
  };
}

export function toOcrPageDto(page: OcrPage): OcrPageDto {
  return {
    pageNumber: page.pageNumber,
    status: page.status,
    method: page.method,
    text: page.text,
    confidence: page.confidence === null ? null : Number(page.confidence),
    charCount: page.charCount,
    truncated: page.truncated,
    errorCode: page.errorCode,
  };
}
