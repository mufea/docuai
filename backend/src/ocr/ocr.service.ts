import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Document,
  DocumentStatus,
  OcrJob,
  OcrJobStatus,
  OcrPage,
  Prisma,
} from '@prisma/client';
import { RequestContext } from '../common/decorators/request-context.decorator';
import { AppConfig, OcrConfig } from '../config/configuration';
import { DocumentsService } from '../documents/documents.service';
import {
  SecurityEventType,
  SecurityEventsService,
} from '../security/security-events.service';
import { OcrResultsQueryDto } from './dto/ocr-results-query.dto';
import { RequestOcrDto } from './dto/request-ocr.dto';
import { OcrJobService } from './ocr-job.service';
import { OcrLanguagesService } from './ocr-languages.service';
import { OcrQueueService } from './ocr-queue.service';
import {
  PERMANENT_OCR_ERROR_CODES,
  ocrAlreadyProcessing,
  ocrDocumentNotReady,
  ocrFileTooLarge,
  ocrNotFound,
  ocrNotReady,
  ocrPageLimitExceeded,
  ocrRetryNotAllowed,
  ocrTooManyJobs,
  ocrUnavailable,
  ocrUnsupportedFileType,
} from './ocr.errors';

export type OcrRequestOutcome = 'created' | 'active' | 'existing';

export interface OcrRequestResult {
  job: OcrJob;
  outcome: OcrRequestOutcome;
}

export interface OcrResults {
  job: OcrJob;
  pages: OcrPage[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const RETRYABLE_STATUSES: OcrJobStatus[] = [
  OcrJobStatus.FAILED,
  OcrJobStatus.PARTIAL,
];

/**
 * API-facing OCR use cases. Every entry point resolves the document through
 * `DocumentsService.getOwned` (owner + not soft-deleted, uniform 404) before
 * any job is looked up, so a job id alone never grants access.
 */
@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  private readonly config: OcrConfig;

  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly documentsService: DocumentsService,
    private readonly jobs: OcrJobService,
    private readonly queue: OcrQueueService,
    private readonly languages: OcrLanguagesService,
    private readonly securityEvents: SecurityEventsService,
  ) {
    this.config = configService.get('ocr', { infer: true });
  }

  /**
   * Duplicate-job policy (evaluated under a per-document lock):
   * 1. an active job with the same language → returned as-is (`active`);
   * 2. an active job with another language → 409 OCR_ALREADY_PROCESSING;
   * 3. latest job for this language COMPLETED/PARTIAL and no force → returned (`existing`);
   * 4. otherwise (none, FAILED, CANCELLED, or forceReprocess) → new job (`created`).
   */
  async request(
    userId: string,
    documentId: string,
    dto: RequestOcrDto,
    ctx: RequestContext,
  ): Promise<OcrRequestResult> {
    if (!this.config.enabled) throw ocrUnavailable();
    const document = await this.documentsService.getOwned(
      userId,
      documentId,
      ctx,
    );
    const language = await this.languages.resolve(dto.language);
    this.assertProcessable(document);
    const force = dto.forceReprocess === true;

    const result = await this.jobs.withDocumentLock(documentId, async (tx) => {
      const active = await this.jobs.activeForDocument(documentId, tx);
      if (active) {
        if (active.language === language) {
          return { job: active, outcome: 'active' as const };
        }
        throw ocrAlreadyProcessing();
      }
      if (!force) {
        const latest = await this.jobs.latestForLanguage(
          documentId,
          language,
          tx,
        );
        if (
          latest &&
          (latest.status === OcrJobStatus.COMPLETED ||
            latest.status === OcrJobStatus.PARTIAL)
        ) {
          return { job: latest, outcome: 'existing' as const };
        }
      }
      await this.assertQuota(userId, documentId, tx);
      const job = await this.createJob(tx, userId, documentId, language);
      return { job, outcome: 'created' as const };
    });

    if (result.outcome === 'created') {
      await this.schedule(result.job);
      this.securityEvents.record(SecurityEventType.OCR_JOB_REQUESTED, {
        userId,
        requestId: ctx.requestId,
        ip: ctx.ipAddress,
        details: {
          documentId,
          ocrJobId: result.job.id,
          language,
          forceReprocess: force,
        },
      });
    }
    return result;
  }

  async status(
    userId: string,
    documentId: string,
    ctx: RequestContext,
  ): Promise<OcrJob> {
    await this.documentsService.getOwned(userId, documentId, ctx);
    const job = await this.jobs.latestForDocument(documentId, userId);
    if (!job) throw ocrNotFound();
    return job;
  }

  /**
   * Page results of a terminal job. QUEUED/PROCESSING jobs answer 409
   * OCR_NOT_READY; PARTIAL/FAILED/CANCELLED jobs return whatever pages were
   * persisted (failed pages carry `text: null` and an `errorCode`).
   */
  async results(
    userId: string,
    documentId: string,
    query: OcrResultsQueryDto,
    ctx: RequestContext,
  ): Promise<OcrResults> {
    await this.documentsService.getOwned(userId, documentId, ctx);
    const job = query.jobId
      ? await this.jobs.findOwned(query.jobId, documentId, userId)
      : await this.jobs.latestForDocument(documentId, userId);
    if (!job) throw ocrNotFound();
    if (
      job.status === OcrJobStatus.QUEUED ||
      job.status === OcrJobStatus.PROCESSING
    ) {
      throw ocrNotReady(job.status);
    }
    const { items, total } = await this.jobs.pages(job.id, {
      page: query.page,
      limit: query.limit,
      pageNumber: query.pageNumber,
    });
    return {
      job,
      pages: items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  /**
   * Creates a fresh job (same language) for the latest job when that job is
   * FAILED or PARTIAL with a non-permanent error. Previous results are kept.
   */
  async retry(
    userId: string,
    documentId: string,
    ctx: RequestContext,
  ): Promise<OcrJob> {
    if (!this.config.enabled) throw ocrUnavailable();
    const document = await this.documentsService.getOwned(
      userId,
      documentId,
      ctx,
    );
    this.assertProcessable(document);

    const job = await this.jobs.withDocumentLock(documentId, async (tx) => {
      const latest = await this.jobs.latestForDocument(documentId, userId, tx);
      if (!latest) throw ocrNotFound();
      if (!RETRYABLE_STATUSES.includes(latest.status)) {
        throw ocrRetryNotAllowed(
          `Only FAILED or PARTIAL jobs can be retried (latest job is ${latest.status})`,
        );
      }
      if (latest.errorCode && PERMANENT_OCR_ERROR_CODES.has(latest.errorCode)) {
        throw ocrRetryNotAllowed(
          `The latest job failed with a permanent error (${latest.errorCode}); the document cannot be processed as-is`,
        );
      }
      await this.languages.resolve(latest.language);
      await this.assertQuota(userId, documentId, tx);
      return this.createJob(tx, userId, documentId, latest.language);
    });

    await this.schedule(job);
    this.securityEvents.record(SecurityEventType.OCR_RETRY_REQUESTED, {
      userId,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      details: { documentId, ocrJobId: job.id, language: job.language },
    });
    return job;
  }

  private assertProcessable(document: Document): void {
    if (
      document.status !== DocumentStatus.READY ||
      !document.storageKey ||
      !document.mimeType
    ) {
      throw ocrDocumentNotReady();
    }
    if (!SUPPORTED_MIME_TYPES.has(document.mimeType)) {
      throw ocrUnsupportedFileType();
    }
    const maxBytes = this.config.limits.maxFileSizeBytes;
    if (document.fileSize !== null && document.fileSize > BigInt(maxBytes)) {
      throw ocrFileTooLarge(maxBytes);
    }
    if (
      document.pageCount !== null &&
      document.pageCount > this.config.limits.maxPdfPages
    ) {
      throw ocrPageLimitExceeded(this.config.limits.maxPdfPages);
    }
  }

  private async assertQuota(
    userId: string,
    documentId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const { maxActiveJobsPerUser, maxJobsPerDocument } = this.config.limits;
    if (
      (await this.jobs.countActiveForUser(userId, tx)) >= maxActiveJobsPerUser
    ) {
      throw ocrTooManyJobs(
        `At most ${maxActiveJobsPerUser} OCR jobs can be queued or processing at once`,
      );
    }
    if (
      (await this.jobs.countForDocument(documentId, tx)) >= maxJobsPerDocument
    ) {
      throw ocrTooManyJobs(
        `This document has reached the limit of ${maxJobsPerDocument} OCR jobs`,
      );
    }
  }

  private createJob(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
    language: string,
  ): Promise<OcrJob> {
    return tx.ocrJob.create({
      data: {
        userId,
        documentId,
        language,
        status: OcrJobStatus.QUEUED,
        maxAttempts: this.config.maxAttempts,
      },
    });
  }

  /**
   * The row is already committed; if Redis is unreachable right now the job
   * stays QUEUED and the worker's reconciler enqueues it on its next run.
   */
  private async schedule(job: OcrJob): Promise<void> {
    try {
      await this.queue.enqueue(job.id);
      this.logger.log(
        `OCR job queued ocrJobId=${job.id} documentId=${job.documentId} language=${job.language}`,
      );
    } catch (error) {
      this.logger.error(
        `OCR job persisted but could not be enqueued (reconciler will retry) ocrJobId=${job.id}: ${(error as Error).message}`,
      );
    }
  }
}
