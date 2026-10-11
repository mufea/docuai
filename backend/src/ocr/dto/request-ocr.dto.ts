import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { TrimString } from '../../common/validation/text.validation';

/** `code` or `code+code` with Tesseract-style codes (`eng`, `chi_sim`, ...). */
export const OCR_LANGUAGE_PATTERN =
  /^[a-z]{3}(_[a-z]+)?(\+[a-z]{3}(_[a-z]+)?)*$/;

export class RequestOcrDto {
  @ApiPropertyOptional({
    example: 'ind+eng',
    description:
      'Tesseract language codes joined by `+` (priority order). Only installed languages are accepted; omit for the configured default.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @TrimString()
  @MaxLength(64)
  @Matches(OCR_LANGUAGE_PATTERN, {
    message: 'language must be a `+`-separated list of language codes',
  })
  language?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Create a new job even when a finished job with the same language exists. Active jobs are never duplicated.',
  })
  @IsOptional()
  @IsBoolean()
  forceReprocess?: boolean = false;
}
