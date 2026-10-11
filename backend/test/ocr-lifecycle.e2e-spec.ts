import { ConfigService } from '@nestjs/config';
import { OcrJobStatus, OcrPageStatus } from '@prisma/client';
import { OcrJobService } from '../src/ocr/ocr-job.service';
import { OcrQueueService } from '../src/ocr/ocr-queue.service';
import { OcrWorkerService } from '../src/ocr/ocr-worker.service';
import { OcrErrorCodes, OcrProcessingError } from '../src/ocr/ocr.errors';
import {
  OcrProvider,
  OcrRecognizeInput,
  OcrRecognizeResult,
} from '../src/ocr/providers/ocr-provider.interface';
import { TesseractOcrProvider } from '../src/ocr/providers/tesseract-ocr.provider';
import { RegisteredUser, registerUser } from './utils/auth-helpers';
import {
  getOcrResults,
  getOcrStatus,
  requestOcr,
  uploadFixture,
} from './utils/ocr-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

/**
 * Real engine wrapped so individual tests can inject failures or delays for a
 * given page. Everything else (rendering, persistence, lifecycle) is real.
 */
class ControllableProvider extends OcrProvider {
  failPages = new Set<number>();
  failAll = false;
  delayMs = 0;
  calls = 0;

  constructor(private readonly real: TesseractOcrProvider) {
    super();
  }

  reset(): void {
    this.failPages.clear();
    this.failAll = false;
    this.delayMs = 0;
    this.calls = 0;
  }

  async recognize(input: OcrRecognizeInput): Promise<OcrRecognizeResult> {
    this.calls += 1;
    if (this.delayMs > 0) {
      // Behave like the real provider: a recognition that would outlive its
      // budget is killed and reported as a page timeout.
      if (this.delayMs > input.timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, input.timeoutMs));
        throw OcrProcessingError.transient(
          OcrErrorCodes.OCR_PROCESSING_TIMEOUT,
          'Text recognition exceeded the time limit',
          `simulated kill after ${input.timeoutMs} ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    const page = /page-(\d+)\.png$/.exec(input.imagePath);
    if (this.failAll) {
      throw OcrProcessingError.transient(
        OcrErrorCodes.OCR_PROCESSING_FAILED,
        'Text recognition failed',
        'Command not found: tesseract (simulated engine outage)',
      );
    }
    if (page && this.failPages.has(Number(page[1]))) {
      throw OcrProcessingError.transient(
        OcrErrorCodes.OCR_PROCESSING_FAILED,
        'Text recognition failed',
        'simulated engine crash on one page',
      ).forPage();
    }
    return this.real.recognize(input);
  }

  describe() {
    return this.real.describe();
  }
}

describe('OCR job lifecycle, idempotency and recovery (e2e, manual worker)', () => {
  jest.setTimeout(120_000);

  let ctx: TestContext;
  let alice: RegisteredUser;
  let worker: OcrWorkerService;
  let queue: OcrQueueService;
  let jobs: OcrJobService;
  let provider: ControllableProvider;
  const previousEnv = {
    worker: process.env.OCR_WORKER_ENABLED,
    jobTimeout: process.env.OCR_JOB_TIMEOUT_MS,
  };

  beforeAll(async () => {
    // No embedded consumer: tests drive the worker by hand so that queued /
    // processing states can be inspected and manipulated deterministically.
    process.env.OCR_WORKER_ENABLED = 'false';
    process.env.OCR_JOB_TIMEOUT_MS = '10000';
    ctx = await createTestApp({
      configure: (builder) =>
        builder.overrideProvider(OcrProvider).useFactory({
          inject: [ConfigService],
          factory: (config: ConfigService) =>
            new ControllableProvider(new TesseractOcrProvider(config)),
        }),
    });
    await resetDatabase(ctx.prisma);
    alice = await registerUser(ctx.app, { name: 'Alice' });
    worker = ctx.app.get(OcrWorkerService);
    queue = ctx.app.get(OcrQueueService);
    jobs = ctx.app.get(OcrJobService);
    provider = ctx.app.get(OcrProvider);
  });

  afterAll(async () => {
    await ctx.close();
    process.env.OCR_WORKER_ENABLED = previousEnv.worker;
    process.env.OCR_JOB_TIMEOUT_MS = previousEnv.jobTimeout;
  });

  beforeEach(() => {
    provider.reset();
    ctx.logs.clear();
  });

  async function queuedJob(
    fixtureName = 'scanned.pdf',
    body: Record<string, unknown> = {},
  ) {
    const documentId = await uploadFixture(ctx.app, alice, fixtureName);
    const res = await requestOcr(ctx.app, alice, documentId, body);
    expect(res.status).toBe(202);
    const jobId: string = res.body.data.id;
    expect(worker.workerState).toBe('disabled');
    // The queue entry exists but nothing consumes it in this app.
    expect(await queue.isPending(jobId)).toBe(true);
    return { documentId, jobId };
  }

  const dbJob = (id: string) =>
    ctx.prisma.ocrJob.findUniqueOrThrow({ where: { id } });
  const pagesOf = (id: string) =>
    ctx.prisma.ocrPage.findMany({
      where: { ocrJobId: id },
      orderBy: { pageNumber: 'asc' },
    });

  // ---------------------------------------------------------------------------

  it('QUEUED → PROCESSING → COMPLETED with consistent progress', async () => {
    const { documentId, jobId } = await queuedJob('text-3pages.pdf');
    expect(await dbJob(jobId)).toMatchObject({
      status: OcrJobStatus.QUEUED,
      attemptCount: 0,
      startedAt: null,
    });

    await worker.process(jobId);

    const job = await dbJob(jobId);
    expect(job).toMatchObject({
      status: OcrJobStatus.COMPLETED,
      totalPages: 3,
      processedPages: 3,
      failedPages: 0,
      attemptCount: 1,
      errorCode: null,
    });
    expect(job.startedAt).not.toBeNull();
    expect(job.completedAt).not.toBeNull();
    expect(job.processedPages).toBeLessThanOrEqual(job.totalPages!);
    const status = await getOcrStatus(ctx.app, alice, documentId);
    expect(status.body.data.progress).toBe(100);
    expect(ctx.logs.text).toContain('OCR job started');
    expect(ctx.logs.text).toContain('OCR job completed');
  });

  it('duplicate delivery of a finished job is a no-op', async () => {
    const { jobId } = await queuedJob('text.pdf');
    await worker.process(jobId);
    const before = await dbJob(jobId);
    const pagesBefore = await pagesOf(jobId);

    await worker.process(jobId);
    await worker.process(jobId);

    const after = await dbJob(jobId);
    expect(after.attemptCount).toBe(before.attemptCount);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await pagesOf(jobId)).toEqual(pagesBefore);
    expect(ctx.logs.text).toContain('ignoring duplicate delivery');
  });

  it('concurrent deliveries of the same job process it exactly once', async () => {
    const { jobId } = await queuedJob('scanned.pdf');

    const outcomes = await Promise.allSettled([
      worker.process(jobId),
      worker.process(jobId),
      worker.process(jobId),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect((r.reason as Error).message).toContain(
        'being processed elsewhere',
      );
    }
    const job = await dbJob(jobId);
    expect(job.status).toBe(OcrJobStatus.COMPLETED);
    expect(job.attemptCount).toBe(1);
    expect(await pagesOf(jobId)).toHaveLength(2);
    expect(provider.calls).toBe(2);
  });

  it('a failing page yields PARTIAL with the failed page recorded explicitly', async () => {
    provider.failPages.add(2);
    const { documentId, jobId } = await queuedJob('scanned.pdf');

    await worker.process(jobId);

    const job = await dbJob(jobId);
    expect(job).toMatchObject({
      status: OcrJobStatus.PARTIAL,
      totalPages: 2,
      processedPages: 2,
      failedPages: 1,
      errorCode: OcrErrorCodes.OCR_PROCESSING_FAILED,
      extractionMethod: 'OCR',
    });
    expect(job.errorMessage).toBe('1 of 2 pages could not be processed');

    const results = await getOcrResults(ctx.app, alice, documentId);
    expect(results.status).toBe(200);
    expect(results.body.data.status).toBe(OcrJobStatus.PARTIAL);
    const [first, second] = results.body.data.pages;
    expect(first).toMatchObject({
      pageNumber: 1,
      status: OcrPageStatus.COMPLETED,
    });
    expect(first.text.toLowerCase()).toContain('scanned page one');
    expect(second).toMatchObject({
      pageNumber: 2,
      status: OcrPageStatus.FAILED,
      text: null,
      confidence: null,
      errorCode: OcrErrorCodes.OCR_PROCESSING_FAILED,
    });
    expect(ctx.logs.text).toContain('OCR job partially completed');
  });

  it('a transient job-level failure is retried a bounded number of times, then FAILED', async () => {
    provider.failAll = true;
    const { jobId } = await queuedJob('scanned.pdf');
    const max = (await dbJob(jobId)).maxAttempts;
    expect(max).toBe(Number(process.env.OCR_MAX_RETRIES) + 1);

    // Attempt 1: transient → requeued.
    await expect(worker.process(jobId)).rejects.toBeInstanceOf(Error);
    expect(await dbJob(jobId)).toMatchObject({
      status: OcrJobStatus.QUEUED,
      attemptCount: 1,
      errorCode: OcrErrorCodes.OCR_PROCESSING_FAILED,
    });
    expect(ctx.logs.text).toContain('requeued after transient failure');

    // Attempt 2 (= max): transient again → FAILED, no further attempts.
    await expect(worker.process(jobId)).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
    const failed = await dbJob(jobId);
    expect(failed).toMatchObject({
      status: OcrJobStatus.FAILED,
      attemptCount: max,
      errorCode: OcrErrorCodes.OCR_PROCESSING_FAILED,
    });
    expect(failed.completedAt).not.toBeNull();
    expect(failed.errorMessage).not.toContain('simulated');

    // Attempt 3 must be a no-op.
    await worker.process(jobId);
    expect((await dbJob(jobId)).attemptCount).toBe(max);
    // A PARTIAL/FAILED job with a non-permanent code is retryable via the API.
    expect(await pagesOf(jobId)).toHaveLength(0);
  });

  it('permanent failures are never retried automatically', async () => {
    const { jobId } = await queuedJob('corrupt.pdf');
    await expect(worker.process(jobId)).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
    expect(await dbJob(jobId)).toMatchObject({
      status: OcrJobStatus.FAILED,
      attemptCount: 1,
      errorCode: OcrErrorCodes.OCR_INVALID_FILE,
    });
  });

  it('pages beyond the job deadline fail with OCR_PROCESSING_TIMEOUT (PARTIAL)', async () => {
    // Job budget is 10 s (OCR_JOB_TIMEOUT_MS above). Page 1 takes ~5.5 s and
    // succeeds; page 2 only gets the remaining ~4.5 s, so its recognition is
    // cut off and recorded as a timeout while page 1 is kept.
    provider.delayMs = 5_500;
    const { documentId, jobId } = await queuedJob('scanned.pdf');
    const started = Date.now();
    await worker.process(jobId);
    expect(Date.now() - started).toBeLessThan(15_000);

    const job = await dbJob(jobId);
    expect(job).toMatchObject({
      status: OcrJobStatus.PARTIAL,
      totalPages: 2,
      processedPages: 2,
      failedPages: 1,
      errorCode: OcrErrorCodes.OCR_PROCESSING_TIMEOUT,
    });
    const pages = await pagesOf(jobId);
    expect(pages[0].status).toBe(OcrPageStatus.COMPLETED);
    expect(pages[1]).toMatchObject({
      status: OcrPageStatus.FAILED,
      errorCode: OcrErrorCodes.OCR_PROCESSING_TIMEOUT,
      text: null,
    });
    // Timeouts are not permanent: the API allows a retry.
    const status = await getOcrStatus(ctx.app, alice, documentId);
    expect(status.body.data.errorCode).toBe(
      OcrErrorCodes.OCR_PROCESSING_TIMEOUT,
    );
  });

  it('a job whose document was deleted meanwhile is CANCELLED', async () => {
    const { documentId, jobId } = await queuedJob('text.pdf');
    await ctx.prisma.document.update({
      where: { id: documentId },
      data: { deletedAt: new Date() },
    });

    await worker.process(jobId);

    expect(await dbJob(jobId)).toMatchObject({
      status: OcrJobStatus.CANCELLED,
      errorCode: OcrErrorCodes.OCR_DOCUMENT_UNAVAILABLE,
    });
    expect(await pagesOf(jobId)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  it('recovers a job interrupted mid-processing and resumes after the last persisted page', async () => {
    const { jobId } = await queuedJob('text-3pages.pdf');
    // Simulate a worker that died after page 1: PROCESSING, stale heartbeat,
    // one page persisted, queue entry gone.
    await ctx.prisma.ocrJob.update({
      where: { id: jobId },
      data: {
        status: OcrJobStatus.PROCESSING,
        attemptCount: 1,
        startedAt: new Date(Date.now() - 60_000),
        heartbeatAt: new Date(Date.now() - 60_000),
        totalPages: 3,
        processedPages: 1,
      },
    });
    await ctx.prisma.ocrPage.create({
      data: {
        ocrJobId: jobId,
        pageNumber: 1,
        status: OcrPageStatus.COMPLETED,
        method: 'NATIVE_TEXT',
        text: 'PERSISTED BEFORE CRASH',
        charCount: 22,
      },
    });
    await queue.removeEntry(jobId);
    expect(await queue.isPending(jobId)).toBe(false);

    const summary = await worker.reconcile('test');
    expect(summary.recovered).toBe(1);
    expect(await dbJob(jobId)).toMatchObject({
      status: OcrJobStatus.QUEUED,
      attemptCount: 1,
    });
    expect(await queue.isPending(jobId)).toBe(true);
    expect(ctx.logs.text).toContain('recovered after worker interruption');

    await worker.process(jobId);

    const job = await dbJob(jobId);
    expect(job).toMatchObject({
      status: OcrJobStatus.COMPLETED,
      attemptCount: 2,
      totalPages: 3,
      processedPages: 3,
      failedPages: 0,
    });
    const pages = await pagesOf(jobId);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    // Page 1 was not reprocessed; pages 2 and 3 were extracted now.
    expect(pages[0].text).toBe('PERSISTED BEFORE CRASH');
    expect(pages[1].text?.toLowerCase()).toContain('bravo');
    expect(pages[2].text?.toLowerCase()).toContain('charlie');
    expect(ctx.logs.text).toContain('resumed after interruption');
  });

  it('a live PROCESSING job (fresh heartbeat) is left alone by the reconciler', async () => {
    const { jobId } = await queuedJob('text.pdf');
    await ctx.prisma.ocrJob.update({
      where: { id: jobId },
      data: {
        status: OcrJobStatus.PROCESSING,
        attemptCount: 1,
        heartbeatAt: new Date(),
      },
    });
    const summary = await worker.reconcile('test');
    expect(summary.recovered).toBe(0);
    expect(summary.failed).toBe(0);
    expect((await dbJob(jobId)).status).toBe(OcrJobStatus.PROCESSING);
    // A redelivery while the claim is live is refused, not processed twice.
    await expect(worker.process(jobId)).rejects.toThrow(
      'being processed elsewhere',
    );
    await ctx.prisma.ocrJob.update({
      where: { id: jobId },
      data: { status: OcrJobStatus.CANCELLED, completedAt: new Date() },
    });
  });

  it('an interrupted job with no attempts left is FAILED, never left PROCESSING', async () => {
    const { jobId } = await queuedJob('text.pdf');
    const max = (await dbJob(jobId)).maxAttempts;
    await ctx.prisma.ocrJob.update({
      where: { id: jobId },
      data: {
        status: OcrJobStatus.PROCESSING,
        attemptCount: max,
        heartbeatAt: new Date(Date.now() - 60_000),
      },
    });

    const summary = await worker.reconcile('test');
    expect(summary.failed).toBe(1);
    expect(await dbJob(jobId)).toMatchObject({
      status: OcrJobStatus.FAILED,
      errorCode: OcrErrorCodes.OCR_WORKER_INTERRUPTED,
    });
    expect(ctx.logs.text).toContain('failed after worker interruption');
  });

  it('a job persisted while the queue was unreachable is enqueued by the reconciler', async () => {
    const spy = jest
      .spyOn(queue, 'enqueue')
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const documentId = await uploadFixture(ctx.app, alice, 'text.pdf');
    const res = await requestOcr(ctx.app, alice, documentId);
    spy.mockRestore();

    // Accepted and persisted even though scheduling failed.
    expect(res.status).toBe(202);
    const jobId: string = res.body.data.id;
    expect(await dbJob(jobId)).toMatchObject({ status: OcrJobStatus.QUEUED });
    expect(await queue.isPending(jobId)).toBe(false);
    expect(ctx.logs.text).toContain('could not be enqueued');

    const summary = await worker.reconcile('test');
    expect(summary.enqueued).toBe(1);
    expect(await queue.isPending(jobId)).toBe(true);
    expect(ctx.logs.text).toContain('re-enqueued by reconciler');

    await worker.process(jobId);
    expect((await dbJob(jobId)).status).toBe(OcrJobStatus.COMPLETED);
  });

  it('results of a completed job remain intact after a failed duplicate attempt', async () => {
    const { jobId } = await queuedJob('scanned.pdf');
    await worker.process(jobId);
    const pagesBefore = await pagesOf(jobId);
    expect(pagesBefore).toHaveLength(2);

    provider.failAll = true;
    await worker.process(jobId); // terminal → ignored
    expect(await pagesOf(jobId)).toEqual(pagesBefore);
    expect((await dbJob(jobId)).status).toBe(OcrJobStatus.COMPLETED);
    expect(await jobs.findById(jobId)).toMatchObject({ failedPages: 0 });
  });
});
