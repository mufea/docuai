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
import { FOLDER_NAME_MAX_LENGTH } from './create-folder.dto';

/**
 * Only `name` and `parentId` are editable. `userId`, `id` and timestamps are
 * rejected by the global `forbidNonWhitelisted` validation.
 */
export class UpdateFolderDto {
  @ApiPropertyOptional({
    example: 'Invoices 2026',
    minLength: 1,
    maxLength: FOLDER_NAME_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @TrimString()
  @MinLength(1)
  @MaxLength(FOLDER_NAME_MAX_LENGTH)
  @NoControlCharacters()
  name?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'New parent folder (must belong to the caller) or null to move to the root. Self-parenting and cycles are rejected.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}
