import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { TrimString } from '../../common/validation/text.validation';

export class CompleteUploadDto {
  @ApiPropertyOptional({
    example: '"9bb58f26192e4ba00f01e2e7b136bbd8"',
    description:
      'ETag returned by the storage service for the PUT. When provided it must match the stored object.',
  })
  @IsOptional()
  @IsString()
  @TrimString()
  @MaxLength(128)
  @Matches(/^"?[A-Za-z0-9-]+"?$/, { message: 'etag has an invalid format' })
  etag?: string;
}
