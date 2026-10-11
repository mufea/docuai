import { ApiPropertyOptional } from '@nestjs/swagger';
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
import {
  DOCUMENT_DESCRIPTION_MAX_LENGTH,
  DOCUMENT_TITLE_MAX_LENGTH,
} from './create-document.dto';

/**
 * Editable metadata only. Owner, status, storage key, file size, MIME type
 * and timestamps can never be changed through this endpoint: any such field
 * in the body is rejected with VALIDATION_ERROR.
 */
export class UpdateDocumentDto {
  @ApiPropertyOptional({
    example: 'Invoice March 2026 (final)',
    minLength: 1,
    maxLength: DOCUMENT_TITLE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @TrimString()
  @MinLength(1)
  @MaxLength(DOCUMENT_TITLE_MAX_LENGTH)
  @NoControlCharacters()
  title?: string;

  @ApiPropertyOptional({
    maxLength: DOCUMENT_DESCRIPTION_MAX_LENGTH,
    nullable: true,
    description: 'Send null to clear.',
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
    description:
      'Move to this folder (must belong to the caller) or null for the root.',
  })
  @IsOptional()
  @IsUUID()
  folderId?: string | null;
}
