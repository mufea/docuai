import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Document, DocumentStatus } from '@prisma/client';

/**
 * The only document shape that leaves the API. Fields are copied explicitly:
 * `userId` (the caller is always the owner), `storageKey` and `deletedAt`
 * are never exposed.
 */
export class DocumentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  folderId!: string | null;

  @ApiProperty({ example: 'Invoice March 2026' })
  title!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({ enum: DocumentStatus })
  status!: DocumentStatus;

  @ApiPropertyOptional({ nullable: true, example: 'application/pdf' })
  mimeType!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 1048576,
    description: 'Bytes. Declared on upload-url, verified on upload-complete.',
  })
  fileSize!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Reserved for a later phase; always null in Phase 2.',
  })
  pageCount!: number | null;

  @ApiPropertyOptional({ nullable: true, example: 'invoice.pdf' })
  originalName!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export function toDocumentDto(document: Document): DocumentDto {
  return {
    id: document.id,
    folderId: document.folderId,
    title: document.title,
    description: document.description,
    status: document.status,
    mimeType: document.mimeType,
    fileSize: document.fileSize === null ? null : Number(document.fileSize),
    pageCount: document.pageCount,
    originalName: document.originalName,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

export class PaginationDto {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}

export class PaginatedDocumentsDto {
  @ApiProperty({ type: DocumentDto, isArray: true })
  items!: DocumentDto[];

  @ApiProperty({ type: PaginationDto })
  pagination!: PaginationDto;
}

export class DocumentDeletionResultDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: [DocumentStatus.DELETED] })
  status!: 'DELETED';

  @ApiProperty({ format: 'date-time' })
  deletedAt!: Date;
}

export class UploadUrlResponseDto {
  @ApiProperty({
    description:
      'Short-lived presigned URL. PUT the raw file body to it with exactly the headers below.',
  })
  uploadUrl!: string;

  @ApiProperty({ example: 'PUT' })
  method!: 'PUT';

  @ApiProperty({
    example: { 'Content-Type': 'application/pdf', 'Content-Length': '1048576' },
    description: 'Headers the client must send verbatim; they are signed.',
  })
  headers!: Record<string, string>;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: Date;

  @ApiProperty({ example: 900 })
  expiresInSeconds!: number;

  @ApiProperty({ type: DocumentDto })
  document!: DocumentDto;
}

export class DownloadUrlResponseDto {
  @ApiProperty({ description: 'Short-lived presigned GET URL.' })
  downloadUrl!: string;

  @ApiProperty({ example: 'GET' })
  method!: 'GET';

  @ApiProperty({ format: 'date-time' })
  expiresAt!: Date;

  @ApiProperty({ example: 300 })
  expiresInSeconds!: number;

  @ApiProperty({ example: 'invoice.pdf' })
  fileName!: string;

  @ApiProperty({ example: 'application/pdf' })
  contentType!: string;

  @ApiProperty({ example: 1048576 })
  fileSize!: number;
}
