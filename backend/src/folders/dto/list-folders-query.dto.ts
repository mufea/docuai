import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { NullableQueryValue } from '../../common/validation/text.validation';

export class ListFoldersQueryDto {
  @ApiPropertyOptional({
    description:
      'Filter by parent. Omit for all folders, `null` for root folders only, or a folder id for its direct children.',
    example: 'null',
  })
  @IsOptional()
  @NullableQueryValue()
  @IsUUID()
  parentId?: string | null;
}
