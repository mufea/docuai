import { ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  NoControlCharacters,
  NullableQueryValue,
  TrimString,
} from '../../common/validation/text.validation';

export const DOCUMENTS_DEFAULT_PAGE_SIZE = 20;
export const DOCUMENTS_MAX_PAGE_SIZE = 100;
export const DOCUMENTS_MAX_PAGE = 100_000;
export const DOCUMENTS_SEARCH_MAX_LENGTH = 200;

/** Allowlist of sortable columns; anything else fails validation. */
export const DOCUMENT_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'title',
  'fileSize',
] as const;
export type DocumentSortField = (typeof DOCUMENT_SORT_FIELDS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/** Soft-deleted documents are never listable, so DELETED is not a filter. */
export const LISTABLE_DOCUMENT_STATUSES = [
  DocumentStatus.DRAFT,
  DocumentStatus.UPLOADING,
  DocumentStatus.READY,
  DocumentStatus.PROCESSING,
  DocumentStatus.FAILED,
] as const;
export type ListableDocumentStatus =
  (typeof LISTABLE_DOCUMENT_STATUSES)[number];

const toInteger = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export class ListDocumentsQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Transform(toInteger)
  @IsInt()
  @Min(1)
  @Max(DOCUMENTS_MAX_PAGE)
  page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: DOCUMENTS_MAX_PAGE_SIZE,
    default: DOCUMENTS_DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Transform(toInteger)
  @IsInt()
  @Min(1)
  @Max(DOCUMENTS_MAX_PAGE_SIZE)
  limit: number = DOCUMENTS_DEFAULT_PAGE_SIZE;

  @ApiPropertyOptional({
    description:
      'Omit for all folders, `null` for root documents only, or a folder id (must belong to the caller).',
    example: 'null',
  })
  @IsOptional()
  @NullableQueryValue()
  @IsUUID()
  folderId?: string | null;

  @ApiPropertyOptional({ enum: LISTABLE_DOCUMENT_STATUSES })
  @IsOptional()
  @IsIn(LISTABLE_DOCUMENT_STATUSES)
  status?: ListableDocumentStatus;

  @ApiPropertyOptional({
    maxLength: DOCUMENTS_SEARCH_MAX_LENGTH,
    description: 'Case-insensitive substring match on title and description.',
  })
  @IsOptional()
  @IsString()
  @TrimString()
  @MaxLength(DOCUMENTS_SEARCH_MAX_LENGTH)
  @NoControlCharacters()
  search?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(DOCUMENT_SORT_FIELDS)
  sort: DocumentSortField = 'createdAt';

  @ApiPropertyOptional({ enum: SORT_ORDERS, default: 'desc' })
  @IsOptional()
  @IsIn(SORT_ORDERS)
  order: SortOrder = 'desc';
}
