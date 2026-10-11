import { Injectable } from '@nestjs/common';
import { Folder, Prisma } from '@prisma/client';
import { RequestContext } from '../common/decorators/request-context.decorator';
import { PrismaService } from '../prisma/prisma.service';
import {
  SecurityEventType,
  SecurityEventsService,
} from '../security/security-events.service';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import {
  MAX_FOLDER_DEPTH,
  folderCycle,
  folderDepthExceeded,
  folderNotFound,
  folderSelfParent,
} from './folders.errors';

export interface FolderDeletionResult {
  id: string;
  movedDocuments: number;
  promotedFolders: number;
}

/** Hard bound for the recursive CTEs; well above MAX_FOLDER_DEPTH. */
const RECURSION_LIMIT = 64;

/** Advisory-lock namespace for per-user hierarchy mutations. */
const FOLDER_LOCK_CLASS = 2001;

/**
 * Folder hierarchy management. Every query is scoped by `userId`, so a folder
 * id belonging to another user behaves exactly like a non-existent id.
 *
 * Hierarchy mutations (create under a parent, move, delete) run in a
 * transaction holding a per-user advisory lock. Two concurrent moves such as
 * A→B and B→A therefore serialise and the second one is rejected by the
 * cycle check instead of silently corrupting the tree.
 */
@Injectable()
export class FoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventsService,
  ) {}

  async create(
    userId: string,
    dto: CreateFolderDto,
    ctx: RequestContext,
  ): Promise<Folder> {
    const parentId = dto.parentId ?? null;

    const folder = await this.prisma.$transaction(async (tx) => {
      await this.lockUserHierarchy(tx, userId);
      if (parentId) {
        const chain = await this.ancestorChain(tx, userId, parentId);
        if (chain.length === 0) {
          throw await this.notFound(userId, parentId, ctx);
        }
        if (chain.length + 1 > MAX_FOLDER_DEPTH) throw folderDepthExceeded();
      }
      return tx.folder.create({ data: { userId, name: dto.name, parentId } });
    });

    this.securityEvents.record(SecurityEventType.FOLDER_CREATED, {
      userId,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      details: { folderId: folder.id, parentId: folder.parentId },
    });
    return folder;
  }

  /**
   * `parentId` undefined → every folder of the user; `null` → root folders;
   * a folder id → direct children (the parent must belong to the user).
   */
  async list(
    userId: string,
    parentId: string | null | undefined,
    ctx: RequestContext,
  ): Promise<Folder[]> {
    if (parentId) {
      await this.getOwned(userId, parentId, ctx);
    }
    return this.prisma.folder.findMany({
      where: {
        userId,
        ...(parentId !== undefined ? { parentId } : {}),
      },
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Loads a folder of the user or throws the safe `FOLDER_NOT_FOUND`. */
  async getOwned(
    userId: string,
    folderId: string,
    ctx: RequestContext,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<Folder> {
    const folder = await tx.folder.findFirst({
      where: { id: folderId, userId },
    });
    if (!folder) throw await this.notFound(userId, folderId, ctx, tx);
    return folder;
  }

  async update(
    userId: string,
    folderId: string,
    dto: UpdateFolderDto,
    ctx: RequestContext,
  ): Promise<Folder> {
    const folder = await this.prisma.$transaction(async (tx) => {
      await this.lockUserHierarchy(tx, userId);
      const current = await this.getOwned(userId, folderId, ctx, tx);

      const data: Prisma.FolderUncheckedUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;

      if (dto.parentId !== undefined && dto.parentId !== current.parentId) {
        await this.assertValidMove(tx, userId, current, dto.parentId, ctx);
        data.parentId = dto.parentId;
      }

      if (Object.keys(data).length === 0) return current;
      return tx.folder.update({ where: { id: current.id }, data });
    });

    this.securityEvents.record(SecurityEventType.FOLDER_UPDATED, {
      userId,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      details: {
        folderId: folder.id,
        parentId: folder.parentId,
        renamed: dto.name !== undefined,
      },
    });
    return folder;
  }

  /**
   * Deletes a folder without ever deleting documents:
   * - documents inside it (including soft-deleted ones) move to the root;
   * - child folders are re-parented to the deleted folder's parent;
   * - the folder row is removed.
   * All three steps run in one transaction scoped to the owner.
   */
  async remove(
    userId: string,
    folderId: string,
    ctx: RequestContext,
  ): Promise<FolderDeletionResult> {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockUserHierarchy(tx, userId);
      const folder = await this.getOwned(userId, folderId, ctx, tx);

      const documents = await tx.document.updateMany({
        where: { folderId: folder.id, userId },
        data: { folderId: null },
      });
      const children = await tx.folder.updateMany({
        where: { parentId: folder.id, userId },
        data: { parentId: folder.parentId },
      });
      const deleted = await tx.folder.deleteMany({
        where: { id: folder.id, userId },
      });
      if (deleted.count !== 1) throw folderNotFound();

      return {
        id: folder.id,
        movedDocuments: documents.count,
        promotedFolders: children.count,
      };
    });

    this.securityEvents.record(SecurityEventType.FOLDER_DELETED, {
      userId,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      details: {
        folderId: result.id,
        movedDocuments: result.movedDocuments,
        promotedFolders: result.promotedFolders,
      },
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Hierarchy validation
  // ---------------------------------------------------------------------------

  private async assertValidMove(
    tx: Prisma.TransactionClient,
    userId: string,
    folder: Folder,
    newParentId: string | null,
    ctx: RequestContext,
  ): Promise<void> {
    if (newParentId === folder.id) throw folderSelfParent();

    let parentDepth = 0;
    if (newParentId !== null) {
      const chain = await this.ancestorChain(tx, userId, newParentId);
      if (chain.length === 0) {
        throw await this.notFound(userId, newParentId, ctx, tx);
      }
      if (chain.includes(folder.id)) throw folderCycle();
      parentDepth = chain.length;
    }

    const height = await this.subtreeHeight(tx, userId, folder.id);
    if (parentDepth + height > MAX_FOLDER_DEPTH) throw folderDepthExceeded();
  }

  /**
   * Ids of `folderId` and all of its ancestors (nearest first), restricted to
   * the user's folders. Empty when the folder is not the user's.
   */
  private async ancestorChain(
    tx: Prisma.TransactionClient,
    userId: string,
    folderId: string,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, 1 AS depth
        FROM folders
        WHERE id = ${folderId}::uuid AND user_id = ${userId}::uuid
        UNION ALL
        SELECT f.id, f.parent_id, c.depth + 1
        FROM folders f
        JOIN chain c ON f.id = c.parent_id
        WHERE f.user_id = ${userId}::uuid AND c.depth < ${RECURSION_LIMIT}::int
      )
      SELECT id FROM chain ORDER BY depth ASC
    `;
    return rows.map((row) => row.id);
  }

  /** Height of the subtree rooted at `folderId` (the folder alone = 1). */
  private async subtreeHeight(
    tx: Prisma.TransactionClient,
    userId: string,
    folderId: string,
  ): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ height: number }>>`
      WITH RECURSIVE sub AS (
        SELECT id, 1 AS depth
        FROM folders
        WHERE id = ${folderId}::uuid AND user_id = ${userId}::uuid
        UNION ALL
        SELECT f.id, s.depth + 1
        FROM folders f
        JOIN sub s ON f.parent_id = s.id
        WHERE f.user_id = ${userId}::uuid AND s.depth < ${RECURSION_LIMIT}::int
      )
      SELECT COALESCE(MAX(depth), 0)::int AS height FROM sub
    `;
    return rows[0]?.height ?? 0;
  }

  private async lockUserHierarchy(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FOLDER_LOCK_CLASS}::int, hashtext(${userId}))`;
  }

  /**
   * Builds the safe not-found error. When the id exists but belongs to
   * someone else, a `FOLDER_ACCESS_DENIED` security event is recorded; the
   * client response is identical in both cases.
   */
  private async notFound(
    userId: string,
    folderId: string,
    ctx: RequestContext,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const foreign = await tx.folder.count({ where: { id: folderId } });
    if (foreign > 0) {
      this.securityEvents.record(SecurityEventType.FOLDER_ACCESS_DENIED, {
        userId,
        requestId: ctx.requestId,
        ip: ctx.ipAddress,
        reason: 'not_owner',
        details: { folderId },
      });
    }
    return folderNotFound();
  }
}
