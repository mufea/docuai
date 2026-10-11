import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export const OCR_RESULTS_DEFAULT_PAGE_SIZE = 10;
/** Page texts can be large; keep one response bounded. */
export const OCR_RESULTS_MAX_PAGE_SIZE = 50;
export const OCR_RESULTS_MAX_PAGE = 100_000;

const toInteger = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export class OcrResultsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description: 'Result page (not document page).',
  })
  @IsOptional()
  @Transform(toInteger)
  @IsInt()
  @Min(1)
  @Max(OCR_RESULTS_MAX_PAGE)
  page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: OCR_RESULTS_MAX_PAGE_SIZE,
    default: OCR_RESULTS_DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Transform(toInteger)
  @IsInt()
  @Min(1)
  @Max(OCR_RESULTS_MAX_PAGE_SIZE)
  limit: number = OCR_RESULTS_DEFAULT_PAGE_SIZE;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'Return only this document page (1-based).',
  })
  @IsOptional()
  @Transform(toInteger)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  pageNumber?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Inspect a specific job of this document (e.g. a previous attempt). Defaults to the latest job.',
  })
  @IsOptional()
  @IsUUID()
  jobId?: string;
}
