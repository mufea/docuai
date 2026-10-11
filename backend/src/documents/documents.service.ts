import { Injectable } from '@nestjs/common';
import { Document, DocumentStatus, Prisma } from '@prisma/client';
import { RequestContext } from '../common/decorators/request-context.decorator';
import { FoldersService } from '../folders/folders.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  SecurityEventType,
  SecurityEventsService,
} from '../security/security-events.service';
import { documentNotFound } from './documents.errors';
import { CreateDocumentDto } from './dto/create-document.dto';
import {
  DocumentSortField,
  ListDocumentsQueryDto,
} from './dto/list-documents-query.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';

export interface DocumentPage {
  items: Document[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface DocumentDeletion {
  id: string;
  status: 'DELETED';
  deletedAt: Date;
}

/**
 * Maps the validated `sort` value onto a Prisma orderBy. The DTO allowlist
 * guarantees `field` is one of these keys; nothing is interpolated into SQL.
 */
const SORT_COLUMNS: Record<
  DocumentSortField,
  keyof Prisma.DocumentOrderByWithRelationInput
> = {
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  title: 'title',
  fileSize: 'fileSize',
};

/**
 * Document metadata management. Every query is scoped by the authenticated
 * user's id and excludes soft-deleted rows, so foreign, unknown and deleted
 * document ids all behave identically (`DOCUMENT_NOT_FOUND`).
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foldersService: FoldersService,
    private readonly securityEvents: SecurityEventsService,
  ) {}

  async create(
    userId: string,
    dto: CreateDocumentDto,
    ctx: RequestContext,
  ): Promise<Document> {
    const folderId = dto.folderId ?? null;
    if (folderId) await this.foldersService.getOwned(userId, folderId, ctx);

    const document = await this.prisma.document.create({
      data: {
        userId,
        folderId,
        title: dto.title,
        description: emptyToNull(dto.description),
        status: DocumentStatus.DRAFT,
      },
    });

    this.securityEvents.record(SecurityEventType.DOCUMENT_CREATED, {
      userId,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      details: { documentId: document.id, folderId: document.folderId },
    });
    return document;
  }

  async list(
    userId: string,
    query: ListDocumentsQueryDto,
    ctx: RequestContext,
  ): Promise<DocumentPage> {
    if (query.folderId) {
      await this.foldersService.getOwned(userId, query.folderId, ctx);
    }

    const where: Prisma.DocumentWhereInput = {
      userId,
      deletedAt: null,
      ...(query.folderId !== undefined ? { folderId: query.folderId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const orderBy: Prisma.DocumentOrderByWithRelationInput[] = [
      { [SORT_COLUMNS[query.sort]]: query.order },
      // Stable tie-breaker so pages never overlap or skip rows.
      { id: 'asc' },
    ];

    const [total, items] = await this.prisma.$transaction([
      this.prisma.document.count({ where }),
      this.prisma.document.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  /** Loads a live (non-deleted) document of the user or throws the safe 404. */
  async getOwned(
    userId: string,
    documentId: string,
    ctx: RequestContext,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<Document> {
    const document = await tx.document.findFirst({
      where: { id: documentId, userId, deletedAt: null },
    });
    if (!document) throw await this.notFound(userId, documentId, ctx, tx);
    return document;
  }

  async update(
    userId: string,
    documentId: string,
    dto: UpdateDocumentDto,
    ctx: RequestContext,
  ): Promise<Document> {
    const current = await this.getOwned(userId, documentId, ctx);

    const data: Prisma.DocumentUncheckedUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) {
      data.description = emptyToNull(dto.description);
    }
    if (dto.folderId !== undefined) {
      if (dto.folderId) {
        await this.foldersService.getOwned(userId, dto.folderId, ctx);
      }
      data.folderId = dto.folderId;
    }

    if (Object.keys(data).length === 0) return current;

    // Ownership and liveness are re-checked in the WHERE clause so a
    // concurrent delete cannot be undone by this update.
    const updated = await this.prisma.document.updateMany({
      where: { id: current.id, userId, deletedAt: null },
      data,
    });
    if (updated.count !== 1) throw documentNotFound();

    const document = await this.getOwned(userId, documentId, ctx);
    this.securityEvents.record(SecurityEventType.DOCUMENT_UPDATED, {
      userId,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      details: {
        documentId: document.id,
        folderId: document.folderId,
        fields: Object.keys(data).sort().join(','),
      },
    });
    return document;
  }

  /**
   * Soft delete: `deletedAt` is set and `status` becomes DELETED. The row and
   * the storage object are retained for a later clean-up mechanism; the
   * object is unreachable through the API from this moment on because every
   * document lookup filters `deletedAt IS NULL`.
   *
   * Not idempotent by design: a second delete (like any access to a deleted
   * document) yields DOCUMENT_NOT_FOUND.
   */
  async remove(
    userId: string,
    documentId: string,
    ctx: RequestContext,
  ): Promise<DocumentDeletion> {
    const deletedAt = new Date();
    const result = await this.prisma.document.updateMany({
      where: { id: documentId, userId, deletedAt: null },
      data: { deletedAt, status: DocumentStatus.DELETED },
    });
    if (result.count !== 1) {
      throw await this.notFound(userId, documentId, ctx);
    }

    this.securityEvents.record(SecurityEventType.DOCUMENT_DELETED, {
      userId,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      details: { documentId },
    });
    return { id: documentId, status: 'DELETED', deletedAt };
  }

  /**
   * Safe not-found. When the id exists for another user, a
   * `DOCUMENT_ACCESS_DENIED` security event is recorded; the response to the
   * client is identical for unknown, deleted and foreign documents.
   */
  async notFound(
    userId: string,
    documentId: string,
    ctx: RequestContext,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const foreign = await tx.document.count({
      where: { id: documentId, NOT: { userId } },
    });
    if (foreign > 0) {
      this.securityEvents.record(SecurityEventType.DOCUMENT_ACCESS_DENIED, {
        userId,
        requestId: ctx.requestId,
        ip: ctx.ipAddress,
        reason: 'not_owner',
        details: { documentId },
      });
    }
    return documentNotFound();
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}
