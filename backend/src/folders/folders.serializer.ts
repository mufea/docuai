import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Folder } from '@prisma/client';

/** The only folder shape that leaves the API; `userId` is never included. */
export class FolderDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Invoices' })
  name!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  parentId!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export function toFolderDto(folder: Folder): FolderDto {
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}

export class FolderDeletionResultDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    example: 3,
    description: 'Documents moved to the root (folderId = null).',
  })
  movedDocuments!: number;

  @ApiProperty({
    example: 1,
    description: "Child folders re-parented to the deleted folder's parent.",
  })
  promotedFolders!: number;
}
