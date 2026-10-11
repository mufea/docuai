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

export const FOLDER_NAME_MAX_LENGTH = 100;

export class CreateFolderDto {
  @ApiProperty({
    example: 'Invoices',
    minLength: 1,
    maxLength: FOLDER_NAME_MAX_LENGTH,
    description: 'Trimmed; control characters are rejected.',
  })
  @IsString()
  @TrimString()
  @MinLength(1)
  @MaxLength(FOLDER_NAME_MAX_LENGTH)
  @NoControlCharacters()
  name!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Parent folder. Must belong to the caller. Omit or send null for a root folder.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}
