import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  NoControlCharacters,
  TrimString,
} from '../../common/validation/text.validation';
import { FILE_NAME_MAX_LENGTH } from '../file-name';

/** `type/subtype`, optionally with parameters; no spaces inside the token. */
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(\s*;.*)?$/i;

/**
 * Everything here is a *declaration* by the client. The server validates it
 * against the configured limits, signs the declared type and size into the
 * upload URL, and re-verifies the stored object on upload-complete. No
 * storage key or path can be supplied: it is always generated server-side.
 */
export class CreateUploadUrlDto {
  @ApiProperty({
    example: 'invoice.pdf',
    maxLength: FILE_NAME_MAX_LENGTH,
    description:
      'Original file name, used for display and the download file name only. Path components are stripped.',
  })
  @IsString()
  @TrimString()
  @MinLength(1)
  @MaxLength(FILE_NAME_MAX_LENGTH)
  @NoControlCharacters()
  fileName!: string;

  @ApiProperty({
    example: 'application/pdf',
    description: 'Must be in the configured allowlist.',
  })
  @IsString()
  @TrimString()
  @MinLength(3)
  @MaxLength(127)
  @Matches(MIME_TYPE_PATTERN, {
    message: 'contentType must be a valid MIME type',
  })
  contentType!: string;

  @ApiProperty({
    example: 1048576,
    minimum: 1,
    description: 'Exact size in bytes; zero-byte files are rejected.',
  })
  @IsInt()
  @Min(1)
  fileSize!: number;
}
