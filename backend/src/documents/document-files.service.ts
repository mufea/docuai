import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Document, DocumentStatus } from '@prisma/client';
import { ErrorCodes } from '../common/constants/error-codes';
import { RequestContext } from '../common/decorators/request-context.decorator';
import { AppException } from '../common/exceptions/app.exception';
import {
  AppConfig,
  DocumentsConfig,
  StorageConfig,
} from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import {
  SecurityEventType,
  SecurityEventsService,
} from '../security/security-events.service';
import { buildStorageKey } from '../storage/storage-key';
import { PresignedUrl, StorageProvider } from '../storage/storage.provider';
import {
  fileTooLarge,
  invalidUpload,
  unsupportedFileType,
  uploadNotFound,
  uploadNotReady,
} from './documents.errors';
import { DocumentsService } from './documents.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import {
  attachmentContentDisposition,
  extensionOf,
  mimeTypeForExtension,
  normalizeMimeType,
  sanitizeFileName,
} from './file-name';

export interface UploadUrlResult {
  presigned: PresignedUrl;
  document: Document;
}

export interface DownloadUrlResult {
  presigned: PresignedUrl;
  fileName: string;
  contentType: string;
  fileSize: number;
}

/** States from which a (new) upload may be requested. */
const UPLOADABLE_STATUSES: DocumentStatus[] = [
  DocumentStatus.DRAFT,
  DocumentStatus.UPLOADING,
  DocumentStatus.FAILED,
];

/**
 * Presigned upload / download lifecycle:
 *
 *   DRAFT ──upload-url──► UPLOADING ──upload-complete (object verified)──► READY
 *                            │                     │
 *                            └── upload-url again  └── verification failed ──► FAILED ──upload-url──► UPLOADING
 *
 * The client never touches storage credentials, never chooses a key, and
 * cannot flip a document to READY without an object actually existing under
 * the server-generated key with the declared size and type.
 */
@Injectable()
export class DocumentFilesService {
  private readonly logger = new Logger(DocumentFilesService.name);
  private readonly documentsConfig: DocumentsConfig;
  private readonly storageConfig: StorageConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly storage: StorageProvider,
    private readonly securityEvents: SecurityEventsService,
    configService: ConfigService<AppConfig, true>,
  ) {
    this.documentsConfig = configService.get('documents', { infer: true });
    this.storageConfig = configService.get('storage', { infer: true });
  }

  // ---------------------------------------------------------------------------
  // upload-url
  // ---------------------------------------------------------------------------

  async createUploadUrl(
    userId: string,
    documentId: string,
    dto: CreateUploadUrlDto,
    ctx: RequestContext,
  ): Promise<UploadUrlResult> {
    const contentType = this.validateContentType(dto.contentType);
    const fileSize = this.validateFileSize(dto.fileSize);
    const fileName = this.validateFileName(dto.fileName, contentType);

    const current = await this.documents.getOwned(userId, documentId, ctx);
    if (!UPLOADABLE_STATUSES.includes(current.status)) {
      throw invalidUpload(
        'This document already has a file; create a new document to upload another one',
      );
    }

    const storageKey = buildStorageKey(userId, current.id);
    const updated = await this.prisma.document.updateMany({
      where: {
        id: current.id,
        userId,
        deletedAt: null,
        status: { in: UPLOADABLE_STATUSES },
      },
      data: {
        status: DocumentStatus.UPLOADING,
        storageKey,
        mimeType: contentType,
        fileSize: BigInt(fileSize),
        originalName: fileName,
        pageCount: null,
      },
    });
    if (updated.count !== 1) {
      throw invalidUpload('The document changed concurrently; retry');
    }

    // A previous upload attempt may have left an object behind that will
    // never be completed now that the key changed. Best-effort removal; a
    // failure only leaves an orphan for the clean-up job, never a leak.
    if (current.storageKey && current.storageKey !== storageKey) {
      await this.storage.deleteObject(current.storageKey).catch(() => {
        this.logger.warn(
          `Could not remove superseded upload object for document ${current.id}`,
        );
      });
    }

    const presigned = await this.storage.createUploadUrl({
      key: storageKey,
      contentType,
      contentLength: fileSize,
      expiresInSeconds: this.storageConfig.uploadUrlTtlSeconds,
    });
    const document = await this.documents.getOwned(userId, documentId, ctx);

    this.securityEvents.record(SecurityEventType.UPLOAD_URL_CREATED, {
      userId,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      details: {
        documentId: document.id,
        contentType,
        fileSize,
        expiresInSeconds: presigned.expiresInSeconds,
      },
    });
    return { presigned, document };
  }

  // ---------------------------------------------------------------------------
  // upload-complete
  // ---------------------------------------------------------------------------

  async completeUpload(
    userId: string,
    documentId: string,
    dto: CompleteUploadDto,
    ctx: RequestContext,
  ): Promise<Document> {
    const current = await this.documents.getOwned(userId, documentId, ctx);

    // Idempotent for a finished upload (e.g. a retried request).
    if (current.status === DocumentStatus.READY) return current;

    if (current.status !== DocumentStatus.UPLOADING || !current.storageKey) {
      throw invalidUpload(
        'No upload is in progress for this document; request an upload URL first',
      );
    }

    const head = await this.storage.headObject(current.storageKey);
    if (!head) throw uploadNotFound();

    const declaredSize = Number(current.fileSize ?? 0);
    const storedType = head.contentType
      ? normalizeMimeType(head.contentType)
      : null;
    const etag = dto.etag?.replace(/^"|"$/g, '') ?? null;

    const problems: string[] = [];
    if (head.size !== declaredSize) problems.push('size_mismatch');
    if (head.size > this.documentsConfig.maxFileSizeBytes) {
      problems.push('too_large');
    }
    if (storedType !== null && storedType !== current.mimeType) {
      problems.push('type_mismatch');
    }
    if (
      storedType !== null &&
      !this.documentsConfig.allowedMimeTypes.includes(storedType)
    ) {
      problems.push('type_not_allowed');
    }
    if (etag && head.etag && etag !== head.etag) problems.push('etag_mismatch');

    if (problems.length > 0) {
      await this.rejectUpload(userId, current, problems, ctx);
      throw invalidUpload(
        'The uploaded file does not match the declared metadata; request a new upload URL and upload again',
      );
    }

    const updated = await this.prisma.document.updateMany({
      where: {
        id: current.id,
        userId,
        deletedAt: null,
        status: DocumentStatus.UPLOADING,
        storageKey: current.storageKey,
      },
      data: {
        status: DocumentStatus.READY,
        fileSize: BigInt(head.size),
        mimeType: storedType ?? current.mimeType,
      },
    });

    const document = await this.documents.getOwned(userId, documentId, ctx);
    if (updated.count !== 1 && document.status !== DocumentStatus.READY) {
      // Lost a race against another upload-url call that changed the key.
      throw invalidUpload('The document changed concurrently; retry');
    }

    if (updated.count === 1) {
      this.securityEvents.record(SecurityEventType.UPLOAD_COMPLETED, {
        userId,
        requestId: ctx.requestId,
        ip: ctx.ipAddress,
        details: {
          documentId: document.id,
          fileSize: head.size,
          contentType: document.mimeType,
        },
      });
    }
    return document;
  }

  /**
   * A stored object that contradicts the declaration is removed (best
   * effort) and the document is marked FAILED so a fresh upload URL must be
   * requested. The object never becomes downloadable.
   */
  private async rejectUpload(
    userId: string,
    document: Document,
    problems: string[],
    ctx: RequestContext,
  ): Promise<void> {
    await this.prisma.document.updateMany({
      where: {
        id: document.id,
        userId,
        status: DocumentStatus.UPLOADING,
        storageKey: document.storageKey,
      },
      data: { status: DocumentStatus.FAILED },
    });
    if (document.storageKey) {
      await this.storage.deleteObject(document.storageKey).catch(() => {
        this.logger.warn(
          `Could not remove rejected upload object for document ${document.id}`,
        );
      });
    }
    this.securityEvents.record(SecurityEventType.UPLOAD_REJECTED, {
      userId,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      reason: problems.join(','),
      details: { documentId: document.id },
    });
  }

  // ---------------------------------------------------------------------------
  // download-url
  // ---------------------------------------------------------------------------

  async createDownloadUrl(
    userId: string,
    documentId: string,
    ctx: RequestContext,
  ): Promise<DownloadUrlResult> {
    const document = await this.documents.getOwned(userId, documentId, ctx);
    if (
      document.status !== DocumentStatus.READY ||
      !document.storageKey ||
      !document.mimeType
    ) {
      throw uploadNotReady();
    }

    const fileName = document.originalName ?? `${document.id}`;
    const presigned = await this.storage.createDownloadUrl({
      key: document.storageKey,
      expiresInSeconds: this.storageConfig.downloadUrlTtlSeconds,
      responseContentType: document.mimeType,
      responseContentDisposition: attachmentContentDisposition(fileName),
    });

    this.securityEvents.record(SecurityEventType.DOWNLOAD_URL_CREATED, {
      userId,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      details: {
        documentId: document.id,
        expiresInSeconds: presigned.expiresInSeconds,
      },
    });
    return {
      presigned,
      fileName,
      contentType: document.mimeType,
      fileSize: Number(document.fileSize ?? 0),
    };
  }

  // ---------------------------------------------------------------------------
  // Declaration validation
  // ---------------------------------------------------------------------------

  private validateContentType(raw: string): string {
    const contentType = normalizeMimeType(raw);
    if (!this.documentsConfig.allowedMimeTypes.includes(contentType)) {
      throw unsupportedFileType(
        `Unsupported file type; allowed: ${this.documentsConfig.allowedMimeTypes.join(', ')}`,
      );
    }
    return contentType;
  }

  private validateFileSize(fileSize: number): number {
    if (!Number.isSafeInteger(fileSize) || fileSize < 1) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCodes.VALIDATION_ERROR,
        'fileSize must be a positive integer',
      );
    }
    if (fileSize > this.documentsConfig.maxFileSizeBytes) {
      throw fileTooLarge(this.documentsConfig.maxFileSizeBytes);
    }
    return fileSize;
  }

  private validateFileName(raw: string, contentType: string): string {
    const fileName = sanitizeFileName(raw);
    if (!fileName) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCodes.VALIDATION_ERROR,
        'fileName is not a valid file name',
      );
    }
    const impliedType = mimeTypeForExtension(extensionOf(fileName));
    if (impliedType && impliedType !== contentType) {
      throw unsupportedFileType(
        'The file extension does not match the declared content type',
      );
    }
    return fileName;
  }
}
