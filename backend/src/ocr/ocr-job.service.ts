import { Injectable } from '@nestjs/common';
import {
  OcrExtractionMethod,
  OcrJob,
  OcrJobStatus,
  OcrPage,
  OcrPageStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExtractedPage } from './ocr-extraction.service';

export const ACTIVE_OCR_STATUSES: OcrJobStatus[] = [
  OcrJobStatus.QUEUED,
  OcrJobStatus.PROCESSING,
];

export const TERMINAL_OCR_STATUSES: OcrJobStatus[] = [
  OcrJobStatus.COMPLETED,
  OcrJobStatus.PARTIAL,
  OcrJobStatus.FAILED,
  OcrJobStatus.CANCELLED,
];

/** Advisory-lock class for per-document OCR job creation. */
const OCR_LOCK_CLASS = 3001;

export interface PageQuery {
  page: number;
  limit: number;
  pageNumber?: number;
}

/**
 * Persistence for OCR jobs and page results. All state transitions are
 * conditional updates (status in the WHERE clause) so a stale worker, a
 * duplicate queue delivery or a concurrent reconciler can never move a job
 * backwards or overwrite a terminal result.
 */
@Injectable()
export class OcrJobService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Creation (API side)
  // ---------------------------------------------------------------------------

  /**
   * Serialises job creation per document: concurrent requests for the same
   * document run one after the other, so the duplicate-job policy evaluated
   * inside `fn` is race-free without a partial unique index.
   */
  withDocumentLock<T>(
    documentId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${OCR_LOCK_CLASS}::int, hashtext(${documentId}))`;
      return fn(tx);
    });
  }

  // ---------------------------------------------------------------------------
  // Queries (API side) — always scoped by owner
  // ---------------------------------------------------------------------------

  latestForDocument(
    documentId: string,
    userId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<OcrJob | null> {
    return tx.ocrJob.findFirst({
      where: { documentId, userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  findOwned(
    jobId: string,
    documentId: string,
    userId: string,
  ): Promise<OcrJob | null> {
    return this.prisma.ocrJob.findFirst({
      where: { id: jobId, documentId, userId },
    });
  }

  activeForDocument(
    documentId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<OcrJob | null> {
    return tx.ocrJob.findFirst({
      where: { documentId, status: { in: ACTIVE_OCR_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
  }

  latestForLanguage(
    documentId: string,
    language: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<OcrJob | null> {
    return tx.ocrJob.findFirst({
      where: { documentId, language },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  countActiveForUser(
    userId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    return tx.ocrJob.count({
      where: { userId, status: { in: ACTIVE_OCR_STATUSES } },
    });
  }

  countForDocument(
    documentId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    return tx.ocrJob.count({ where: { documentId } });
  }

  async pages(
    jobId: string,
    query: PageQuery,
  ): Promise<{ items: OcrPage[]; total: number }> {
    const where: Prisma.OcrPageWhereInput = {
      ocrJobId: jobId,
      ...(query.pageNumber !== undefined
        ? { pageNumber: query.pageNumber }
        : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.ocrPage.count({ where }),
      this.prisma.ocrPage.findMany({
        where,
        orderBy: { pageNumber: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return { items, total };
  }

  // ---------------------------------------------------------------------------
  // Worker side
  // ---------------------------------------------------------------------------

  findById(jobId: string): Promise<OcrJob | null> {
    return this.prisma.ocrJob.findUnique({ where: { id: jobId } });
  }

  /**
   * Takes ownership of a job for one processing attempt. Succeeds for QUEUED
   * jobs and for PROCESSING jobs whose heartbeat is older than `staleMs`
   * (the previous worker died); fails for anything else, which makes
   * duplicate deliveries and concurrent workers no-ops.
   */
  async claim(jobId: string, staleMs: number): Promise<boolean> {
    const staleBefore = new Date(Date.now() - staleMs);
    const updated = await this.prisma.$executeRaw`
      UPDATE "ocr_jobs"
      SET "status" = 'PROCESSING',
          "started_at" = COALESCE("started_at", NOW()),
          "heartbeat_at" = NOW(),
          "attempt_count" = "attempt_count" + 1,
          "error_code" = NULL,
          "error_message" = NULL,
          "updated_at" = NOW()
      WHERE "id" = ${jobId}::uuid
        AND (
          "status" = 'QUEUED'
          OR ("status" = 'PROCESSING' AND ("heartbeat_at" IS NULL OR "heartbeat_at" < ${staleBefore}))
        )
    `;
    return updated === 1;
  }

  async heartbeat(jobId: string): Promise<void> {
    await this.prisma.ocrJob.updateMany({
      where: { id: jobId, status: OcrJobStatus.PROCESSING },
      data: { heartbeatAt: new Date() },
    });
  }

  async setTotalPages(
    jobId: string,
    documentId: string,
    totalPages: number,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.ocrJob.updateMany({
        where: { id: jobId, status: OcrJobStatus.PROCESSING },
        data: { totalPages, heartbeatAt: new Date() },
      }),
      this.prisma.document.updateMany({
        where: { id: documentId, deletedAt: null },
        data: { pageCount: totalPages },
      }),
    ]);
  }

  /** Pages already persisted for a job (resume point after an interruption). */
  async persistedProgress(
    jobId: string,
  ): Promise<{ lastPage: number; chars: number }> {
    const aggregate = await this.prisma.ocrPage.aggregate({
      where: { ocrJobId: jobId },
      _max: { pageNumber: true },
      _sum: { charCount: true },
    });
    return {
      lastPage: aggregate._max.pageNumber ?? 0,
      chars: aggregate._sum.charCount ?? 0,
    };
  }

  /**
   * Stores one page result and refreshes the job counters atomically. The
   * unique (job, page) constraint plus the upsert make a re-delivered page
   * overwrite itself instead of duplicating.
   */
  async persistPage(jobId: string, page: ExtractedPage): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.ocrPage.upsert({
        where: {
          ocrJobId_pageNumber: { ocrJobId: jobId, pageNumber: page.pageNumber },
        },
        create: {
          ocrJobId: jobId,
          pageNumber: page.pageNumber,
          status: page.status,
          method: page.method,
          text: page.text,
          confidence: page.confidence,
          charCount: page.charCount,
          truncated: page.truncated,
          errorCode: page.errorCode,
        },
        update: {
          status: page.status,
          method: page.method,
          text: page.text,
          confidence: page.confidence,
          charCount: page.charCount,
          truncated: page.truncated,
          errorCode: page.errorCode,
        },
      });
      await tx.$executeRaw`
        UPDATE "ocr_jobs" j
        SET "processed_pages" = LEAST(COALESCE(j."total_pages", c.cnt), c.cnt),
            "failed_pages" = c.failed,
            "heartbeat_at" = NOW(),
            "updated_at" = NOW()
        FROM (
          SELECT COUNT(*)::int AS cnt,
                 COUNT(*) FILTER (WHERE "status" = 'FAILED')::int AS failed
          FROM "ocr_pages" WHERE "ocr_job_id" = ${jobId}::uuid
        ) c
        WHERE j."id" = ${jobId}::uuid AND j."status" = 'PROCESSING'
      `;
    });
  }

  /**
   * Derives the terminal status from the persisted pages:
   *   no FAILED page            → COMPLETED
   *   some FAILED, some not     → PARTIAL
   *   every page FAILED         → FAILED
   * Only a PROCESSING job can be finalised; returns the resulting job.
   */
  async finalize(jobId: string): Promise<OcrJob | null> {
    return this.prisma.$transaction(async (tx) => {
      const pages = await tx.ocrPage.findMany({
        where: { ocrJobId: jobId },
        select: { status: true, method: true, errorCode: true },
      });
      const failed = pages.filter((p) => p.status === OcrPageStatus.FAILED);
      const methods = new Set(
        pages.filter((p) => p.method).map((p) => p.method),
      );
      const extractionMethod =
        methods.size === 0
          ? null
          : methods.size > 1
            ? OcrExtractionMethod.MIXED
            : (methods.values().next().value as OcrExtractionMethod);

      let status: OcrJobStatus;
      if (pages.length === 0 || failed.length === pages.length) {
        status = OcrJobStatus.FAILED;
      } else if (failed.length > 0) {
        status = OcrJobStatus.PARTIAL;
      } else {
        status = OcrJobStatus.COMPLETED;
      }
      const dominantError =
        failed.length > 0
          ? mostCommon(
              failed.map((p) => p.errorCode ?? 'OCR_PROCESSING_FAILED'),
            )
          : null;

      const updated = await tx.ocrJob.updateMany({
        where: { id: jobId, status: OcrJobStatus.PROCESSING },
        data: {
          status,
          extractionMethod,
          errorCode: status === OcrJobStatus.COMPLETED ? null : dominantError,
          errorMessage:
            status === OcrJobStatus.COMPLETED
              ? null
              : status === OcrJobStatus.PARTIAL
                ? `${failed.length} of ${pages.length} pages could not be processed`
                : 'No page could be processed',
          completedAt: new Date(),
          heartbeatAt: new Date(),
          processedPages: pages.length,
          failedPages: failed.length,
        },
      });
      if (updated.count !== 1) return null;
      return tx.ocrJob.findUnique({ where: { id: jobId } });
    });
  }

  /** Marks a PROCESSING job FAILED (permanent error or attempts exhausted). */
  async fail(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    const updated = await this.prisma.ocrJob.updateMany({
      where: { id: jobId, status: { in: ACTIVE_OCR_STATUSES } },
      data: {
        status: OcrJobStatus.FAILED,
        errorCode,
        errorMessage: errorMessage.slice(0, 500),
        completedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
    return updated.count === 1;
  }

  /** Returns a PROCESSING job to QUEUED for another attempt. */
  async requeue(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    const updated = await this.prisma.ocrJob.updateMany({
      where: { id: jobId, status: OcrJobStatus.PROCESSING },
      data: {
        status: OcrJobStatus.QUEUED,
        errorCode,
        errorMessage: errorMessage.slice(0, 500),
        heartbeatAt: new Date(),
      },
    });
    return updated.count === 1;
  }

  async cancel(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    const updated = await this.prisma.ocrJob.updateMany({
      where: { id: jobId, status: { in: ACTIVE_OCR_STATUSES } },
      data: {
        status: OcrJobStatus.CANCELLED,
        errorCode,
        errorMessage: errorMessage.slice(0, 500),
        completedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
    return updated.count === 1;
  }

  // ---------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------

  findQueued(): Promise<OcrJob[]> {
    return this.prisma.ocrJob.findMany({
      where: { status: OcrJobStatus.QUEUED },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
  }

  findStaleProcessing(staleMs: number): Promise<OcrJob[]> {
    return this.prisma.ocrJob.findMany({
      where: {
        status: OcrJobStatus.PROCESSING,
        OR: [
          { heartbeatAt: null },
          { heartbeatAt: { lt: new Date(Date.now() - staleMs) } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
  }

  /** Resets an interrupted PROCESSING job to QUEUED (reconciler path). */
  async recover(jobId: string, staleMs: number): Promise<boolean> {
    const staleBefore = new Date(Date.now() - staleMs);
    const updated = await this.prisma.ocrJob.updateMany({
      where: {
        id: jobId,
        status: OcrJobStatus.PROCESSING,
        OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }],
      },
      data: { status: OcrJobStatus.QUEUED, heartbeatAt: new Date() },
    });
    return updated.count === 1;
  }
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0][0];
}
