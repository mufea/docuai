import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentStatus, OcrJob, OcrJobStatus } from '@prisma/client';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { AppConfig, OcrConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { StorageException } from '../storage/storage.errors';
import {
  StorageProvider,
  StoredObjectStream,
} from '../storage/storage.provider';
import { OcrExtractionService } from './ocr-extraction.service';
import { OcrJobService, TERMINAL_OCR_STATUSES } from './ocr-job.service';
import {
  OcrQueuePayload,
  OcrQueueService,
  queueConnectionOptions,
} from './ocr-queue.service';
import { OcrErrorCodes, OcrProcessingError } from './ocr.errors';

export type WorkerState = 'disabled' | 'starting' | 'running' | 'stopped';

/**
 * Consumer side of the OCR queue plus the database/queue reconciler.
 *
 * Processing is idempotent and resumable: the job is claimed with a
 * conditional update, pages are upserted one at a time, progress is derived
 * from the persisted pages and the terminal status is computed from them.
 * A duplicate delivery of a finished job is a no-op; a redelivery of an
 * interrupted job continues after the last persisted page.
 */
@Injectable()
export class OcrWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OcrWorkerService.name);
  private readonly config: OcrConfig;
  private readonly redisUrl: string;
  private worker: Worker | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private state: WorkerState = 'disabled';

  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
    private readonly jobs: OcrJobService,
    private readonly queue: OcrQueueService,
    private readonly extraction: OcrExtractionService,
  ) {
    this.config = configService.get('ocr', { infer: true });
    this.redisUrl = configService.get('redis', { infer: true }).url;
  }

  get workerState(): WorkerState {
    return this.state;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled || !this.config.workerEnabled) return;
    this.state = 'starting';
    await fs.mkdir(this.tmpRoot(), { recursive: true });

    this.worker = new Worker(
      this.config.queueName,
      (job: Job) => this.handle(job),
      {
        connection: queueConnectionOptions(this.redisUrl),
        concurrency: this.config.concurrency,
        // Heavy work runs in subprocesses, so the event loop stays free to
        // renew the lock; a lost lock therefore really means a dead worker.
        lockDuration: 30_000,
        stalledInterval: 30_000,
        maxStalledCount: 1,
      },
    );
    this.worker.on('error', (error: Error) => {
      this.logger.warn(`OCR worker error: ${error.message}`);
    });
    this.worker.on('failed', (job: Job | undefined, error: Error) => {
      const data = job?.data as OcrQueuePayload | undefined;
      this.logger.warn(
        `OCR queue entry failed ocrJobId=${data?.ocrJobId ?? '?'} attempt=${job?.attemptsMade ?? '?'} reason=${error.message}`,
      );
    });
    this.state = 'running';
    this.logger.log(
      `OCR worker started queue=${this.config.queueName} concurrency=${this.config.concurrency}`,
    );

    void this.reconcile('startup');
    this.reconcileTimer = setInterval(
      () => void this.reconcile('interval'),
      this.config.reconcileIntervalMs,
    );
    this.reconcileTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.worker) {
      // Graceful: finish the page in flight, then stop taking work.
      this.logger.log('OCR worker stopping, draining the job in flight');
      await this.worker.close().catch(() => undefined);
      this.worker = null;
      this.logger.log('OCR worker stopped');
    }
    if (this.state !== 'disabled') this.state = 'stopped';
  }

  // ---------------------------------------------------------------------------
  // Processing
  // ---------------------------------------------------------------------------

  private async handle(entry: Job): Promise<void> {
    const ocrJobId = (entry.data as OcrQueuePayload | undefined)?.ocrJobId;
    if (!ocrJobId) return;
    await this.process(ocrJobId);
  }

  /** Processes one persisted job. Public for tests; normally queue-driven. */
  async process(ocrJobId: string): Promise<void> {
    const job = await this.jobs.findById(ocrJobId);
    if (!job) {
      this.logger.warn(`OCR job not found ocrJobId=${ocrJobId}`);
      return;
    }
    if (TERMINAL_OCR_STATUSES.includes(job.status)) {
      this.logger.debug(
        `OCR job already ${job.status}, ignoring duplicate delivery ocrJobId=${ocrJobId}`,
      );
      return;
    }

    const claimed = await this.jobs.claim(ocrJobId, this.config.staleJobMs);
    if (!claimed) {
      // Another worker holds a live claim. Let the queue retry later; by then
      // the job is terminal (no-op) or its heartbeat went stale (claimable).
      throw new Error(`OCR job ${ocrJobId} is being processed elsewhere`);
    }

    const claimedJob = (await this.jobs.findById(ocrJobId)) ?? job;
    if (claimedJob.attemptCount > claimedJob.maxAttempts) {
      await this.jobs.fail(
        ocrJobId,
        OcrErrorCodes.OCR_WORKER_INTERRUPTED,
        'Processing was interrupted and the attempt budget is exhausted',
      );
      this.logger.warn(
        `OCR job failed: attempt budget exhausted ocrJobId=${ocrJobId} documentId=${job.documentId}`,
      );
      throw new UnrecoverableError(OcrErrorCodes.OCR_WORKER_INTERRUPTED);
    }

    this.logger.log(
      `OCR job started ocrJobId=${ocrJobId} documentId=${job.documentId} userId=${job.userId} attempt=${claimedJob.attemptCount}/${claimedJob.maxAttempts} language=${job.language}`,
    );

    const heartbeat = setInterval(
      () => void this.jobs.heartbeat(ocrJobId).catch(() => undefined),
      Math.max(1000, Math.min(10_000, Math.floor(this.config.staleJobMs / 3))),
    );
    const workDir = await fs.mkdtemp(path.join(this.tmpRoot(), 'job-'));
    try {
      await this.run(claimedJob, workDir);
    } catch (error) {
      await this.handleFailure(claimedJob, error);
    } finally {
      clearInterval(heartbeat);
      await fs
        .rm(workDir, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }

  private async run(job: OcrJob, workDir: string): Promise<void> {
    const document = await this.prisma.document.findFirst({
      where: { id: job.documentId, userId: job.userId, deletedAt: null },
    });
    if (
      !document ||
      document.status !== DocumentStatus.READY ||
      !document.storageKey
    ) {
      await this.jobs.cancel(
        job.id,
        OcrErrorCodes.OCR_DOCUMENT_UNAVAILABLE,
        'The document is no longer available for processing',
      );
      this.logger.warn(
        `OCR job cancelled: document unavailable ocrJobId=${job.id} documentId=${job.documentId}`,
      );
      return;
    }

    const maxBytes = this.config.limits.maxFileSizeBytes;
    if (document.fileSize !== null && document.fileSize > BigInt(maxBytes)) {
      throw OcrProcessingError.permanent(
        OcrErrorCodes.OCR_FILE_TOO_LARGE,
        `Documents larger than ${maxBytes} bytes cannot be processed`,
      );
    }

    const inputPath = path.join(workDir, 'input');
    await this.download(document.storageKey, inputPath, maxBytes);

    const inspected = await this.extraction.inspect(
      inputPath,
      document.mimeType,
    );
    await this.jobs.setTotalPages(job.id, document.id, inspected.totalPages);

    const progress = await this.jobs.persistedProgress(job.id);
    if (progress.lastPage > 0) {
      this.logger.log(
        `OCR job resumed after interruption ocrJobId=${job.id} documentId=${job.documentId} fromPage=${progress.lastPage + 1}`,
      );
    }

    const deadline = Date.now() + this.config.jobTimeoutMs;
    const pages = this.extraction.extract({
      filePath: inputPath,
      inspected,
      language: job.language,
      workDir,
      deadline,
      startPage: progress.lastPage + 1,
      charBudget: this.config.limits.maxTextPerDocument - progress.chars,
    });
    for await (const page of pages) {
      await this.jobs.persistPage(job.id, page);
      this.logger.debug(
        `OCR page processed ocrJobId=${job.id} page=${page.pageNumber}/${inspected.totalPages} status=${page.status} method=${page.method ?? '-'} chars=${page.charCount}`,
      );
    }

    const result = await this.jobs.finalize(job.id);
    if (!result) {
      this.logger.warn(
        `OCR job finalisation skipped (no longer PROCESSING) ocrJobId=${job.id}`,
      );
      return;
    }
    const line = `ocrJobId=${job.id} documentId=${job.documentId} pages=${result.processedPages}/${result.totalPages} failedPages=${result.failedPages} method=${result.extractionMethod ?? '-'}`;
    if (result.status === OcrJobStatus.COMPLETED) {
      this.logger.log(`OCR job completed ${line}`);
    } else if (result.status === OcrJobStatus.PARTIAL) {
      this.logger.warn(
        `OCR job partially completed ${line} errorCode=${result.errorCode}`,
      );
    } else {
      this.logger.warn(`OCR job failed ${line} errorCode=${result.errorCode}`);
    }
  }

  /**
   * Streams the private object to the job's work directory, aborting as
   * soon as more than `maxBytes` arrive. Presigned URLs are never involved.
   */
  private async download(
    storageKey: string,
    target: string,
    maxBytes: number,
  ): Promise<void> {
    let object: StoredObjectStream | null;
    try {
      object = await this.storage.getObjectStream(storageKey);
    } catch (error) {
      if (error instanceof StorageException) {
        throw OcrProcessingError.transient(
          OcrErrorCodes.OCR_STORAGE_ERROR,
          'The document could not be read from storage',
        );
      }
      throw error;
    }
    if (!object) {
      throw OcrProcessingError.permanent(
        OcrErrorCodes.OCR_STORAGE_ERROR,
        'The stored file for this document is missing',
      );
    }
    if (object.size !== null && object.size > maxBytes) {
      object.body.destroy();
      throw OcrProcessingError.permanent(
        OcrErrorCodes.OCR_FILE_TOO_LARGE,
        `Documents larger than ${maxBytes} bytes cannot be processed`,
      );
    }

    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) {
          callback(
            OcrProcessingError.permanent(
              OcrErrorCodes.OCR_FILE_TOO_LARGE,
              `Documents larger than ${maxBytes} bytes cannot be processed`,
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        object.body,
        limiter,
        createWriteStream(target, { mode: 0o600 }),
      );
    } catch (error) {
      if (error instanceof OcrProcessingError) throw error;
      throw OcrProcessingError.transient(
        OcrErrorCodes.OCR_STORAGE_ERROR,
        'The document could not be read from storage',
        (error as Error).message,
      );
    }
  }

  private async handleFailure(job: OcrJob, error: unknown): Promise<void> {
    const failure = toProcessingError(error);
    const context = `ocrJobId=${job.id} documentId=${job.documentId} code=${failure.code} attempt=${job.attemptCount}/${job.maxAttempts}`;
    const detail =
      failure.detail ??
      (error instanceof Error ? error.message : String(error));

    if (failure.permanent || job.attemptCount >= job.maxAttempts) {
      await this.jobs.fail(job.id, failure.code, failure.message);
      this.logger.warn(
        `OCR job failed ${context} permanent=${failure.permanent} detail=${detail}`,
      );
      throw new UnrecoverableError(failure.code);
    }

    await this.jobs.requeue(job.id, failure.code, failure.message);
    this.logger.warn(
      `OCR job requeued after transient failure ${context} detail=${detail}`,
    );
    // Re-throw so BullMQ schedules the retry with backoff.
    throw error instanceof Error ? error : new Error(failure.code);
  }

  // ---------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Makes the queue match the database:
   * - QUEUED rows without a pending queue entry are enqueued (covers "row
   *   committed but enqueue failed" and lost Redis state);
   * - PROCESSING rows whose heartbeat is stale (worker died mid-job) are
   *   reset to QUEUED and enqueued, or failed when out of attempts.
   */
  async reconcile(
    trigger: string,
  ): Promise<{ enqueued: number; recovered: number; failed: number }> {
    const summary = { enqueued: 0, recovered: 0, failed: 0 };
    if (this.reconciling) return summary;
    this.reconciling = true;
    try {
      for (const job of await this.jobs.findStaleProcessing(
        this.config.staleJobMs,
      )) {
        if (job.attemptCount >= job.maxAttempts) {
          if (
            await this.jobs.fail(
              job.id,
              OcrErrorCodes.OCR_WORKER_INTERRUPTED,
              'Processing was interrupted and the attempt budget is exhausted',
            )
          ) {
            summary.failed += 1;
            this.logger.warn(
              `OCR job failed after worker interruption ocrJobId=${job.id} documentId=${job.documentId}`,
            );
          }
          continue;
        }
        if (await this.jobs.recover(job.id, this.config.staleJobMs)) {
          await this.queue.removeStaleEntry(job.id);
          await this.queue.enqueue(job.id);
          summary.recovered += 1;
          this.logger.warn(
            `OCR job recovered after worker interruption ocrJobId=${job.id} documentId=${job.documentId} attempt=${job.attemptCount}/${job.maxAttempts}`,
          );
        }
      }

      for (const job of await this.jobs.findQueued()) {
        if (await this.queue.isPending(job.id)) continue;
        await this.queue.removeStaleEntry(job.id);
        await this.queue.enqueue(job.id);
        summary.enqueued += 1;
        this.logger.log(
          `OCR job re-enqueued by reconciler ocrJobId=${job.id} documentId=${job.documentId}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `OCR reconciliation (${trigger}) failed: ${(error as Error).message}`,
      );
    } finally {
      this.reconciling = false;
    }
    return summary;
  }

  private tmpRoot(): string {
    return this.config.tmpDir ?? path.join(os.tmpdir(), 'docuai-ocr');
  }
}

function toProcessingError(error: unknown): OcrProcessingError {
  if (error instanceof OcrProcessingError) return error;
  if (error instanceof StorageException) {
    return OcrProcessingError.transient(
      OcrErrorCodes.OCR_STORAGE_ERROR,
      'The document could not be read from storage',
      error.message,
    );
  }
  return OcrProcessingError.transient(
    OcrErrorCodes.OCR_PROCESSING_FAILED,
    'Text extraction failed unexpectedly',
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
}
