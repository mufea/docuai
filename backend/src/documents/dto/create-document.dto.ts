import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  NoControlCharacters,
  TrimString,
} from '../../common/validation/text.validation';

export const DOCUMENT_TITLE_MAX_LENGTH = 255;
export const DOCUMENT_DESCRIPTION_MAX_LENGTH = 2000;

/**
 * Only metadata the client may set. `userId`, `status`, `storageKey`,
 * `fileSize`, `mimeType` and timestamps are server-controlled and rejected
 * by the global `forbidNonWhitelisted` validation.
 */
export class CreateDocumentDto {
  @ApiProperty({
    example: 'Invoice March 2026',
    minLength: 1,
    maxLength: DOCUMENT_TITLE_MAX_LENGTH,
    description: 'Trimmed; control characters are rejected.',
  })
  @IsString()
  @TrimString()
  @MinLength(1)
  @MaxLength(DOCUMENT_TITLE_MAX_LENGTH)
  @NoControlCharacters()
  title!: string;

  @ApiPropertyOptional({
    example: 'Scanned copy of the March invoice.',
    maxLength: DOCUMENT_DESCRIPTION_MAX_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @TrimString()
  @MaxLength(DOCUMENT_DESCRIPTION_MAX_LENGTH)
  @NoControlCharacters({ allowLineBreaks: true })
  description?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Folder to place the document in. Must belong to the caller.',
  })
  @IsOptional()
  @IsUUID()
  folderId?: string | null;
}
