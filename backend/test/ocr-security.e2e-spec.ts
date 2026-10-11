import { OcrJobStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  RegisteredUser,
  expectErrorEnvelope,
  registerUser,
} from './utils/auth-helpers';
import { createDocument } from './utils/document-helpers';
import {
  getOcrResults,
  getOcrStatus,
  requestOcr,
  retryOcr,
  uploadFixture,
  waitForOcr,
} from './utils/ocr-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

describe('OCR API security & job policy (e2e)', () => {
  jest.setTimeout(120_000);

  let ctx: TestContext;
  let alice: RegisteredUser;
  let bob: RegisteredUser;
  /** Alice's READY text PDF, processed to COMPLETED in beforeAll. */
  let aliceDoc: string;
  let aliceJobId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    alice = await registerUser(ctx.app, { name: 'Alice' });
    bob = await registerUser(ctx.app, { name: 'Bob' });
    aliceDoc = await uploadFixture(ctx.app, alice, 'text-3pages.pdf');
    const res = await requestOcr(ctx.app, alice, aliceDoc);
    expect(res.status).toBe(202);
    aliceJobId = res.body.data.id;
    const job = await waitForOcr(ctx.app, alice, aliceDoc);
    expect(job.status).toBe(OcrJobStatus.COMPLETED);
  });

  afterAll(async () => {
    await ctx.close();
  });

  const server = () => ctx.app.getHttpServer();

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  describe('authentication', () => {
    it.each([
      [
        'POST',
        (id: string) =>
          request(server()).post(`/api/v1/documents/${id}/ocr`).send({}),
      ],
      [
        'GET status',
        (id: string) => request(server()).get(`/api/v1/documents/${id}/ocr`),
      ],
      [
        'GET results',
        (id: string) =>
          request(server()).get(`/api/v1/documents/${id}/ocr/results`),
      ],
      [
        'POST retry',
        (id: string) =>
          request(server()).post(`/api/v1/documents/${id}/ocr/retry`),
      ],
    ])('%s without a token is rejected with 401', async (_name, call) => {
      const res = await call(aliceDoc);
      expect(res.status).toBe(401);
      expectErrorEnvelope(res.body, 'AUTH_UNAUTHORIZED');
    });
  });

  // ---------------------------------------------------------------------------
  // Ownership / IDOR
  // ---------------------------------------------------------------------------

  describe('ownership (IDOR)', () => {
    it("Bob cannot request OCR for Alice's document", async () => {
      ctx.logs.clear();
      const res = await requestOcr(ctx.app, bob, aliceDoc, {});
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'DOCUMENT_NOT_FOUND');
      expect(ctx.logs.text).toContain('DOCUMENT_ACCESS_DENIED');
      // No job was created for Bob.
      expect(
        await ctx.prisma.ocrJob.count({ where: { userId: bob.userId } }),
      ).toBe(0);
    });

    it("Bob cannot inspect Alice's OCR status", async () => {
      const res = await getOcrStatus(ctx.app, bob, aliceDoc);
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'DOCUMENT_NOT_FOUND');
    });

    it("Bob cannot read Alice's OCR results, even with the job id", async () => {
      const res = await getOcrResults(ctx.app, bob, aliceDoc, {
        jobId: aliceJobId,
      });
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'DOCUMENT_NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain('alpha');
    });

    it("Bob cannot retry Alice's job", async () => {
      const res = await retryOcr(ctx.app, bob, aliceDoc);
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'DOCUMENT_NOT_FOUND');
    });

    it("a job id of another user's document is not found via the caller's own document", async () => {
      const bobDoc = await uploadFixture(ctx.app, bob, 'text.pdf');
      await requestOcr(ctx.app, bob, bobDoc);
      await waitForOcr(ctx.app, bob, bobDoc);
      const res = await getOcrResults(ctx.app, bob, bobDoc, {
        jobId: aliceJobId,
      });
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'OCR_NOT_FOUND');
    });

    it('unknown and malformed document ids return 404 / 400', async () => {
      const unknown = await getOcrStatus(ctx.app, alice, randomUUID());
      expect(unknown.status).toBe(404);
      expectErrorEnvelope(unknown.body, 'DOCUMENT_NOT_FOUND');
      const malformed = await request(server())
        .get('/api/v1/documents/not-a-uuid/ocr')
        .set('Authorization', `Bearer ${alice.accessToken}`);
      expect(malformed.status).toBe(400);
      expectErrorEnvelope(malformed.body, 'VALIDATION_ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // Document state
  // ---------------------------------------------------------------------------

  describe('document state', () => {
    it('soft-deleted documents cannot be processed or inspected', async () => {
      const doc = await uploadFixture(ctx.app, alice, 'text.pdf');
      await requestOcr(ctx.app, alice, doc);
      await waitForOcr(ctx.app, alice, doc);
      const del = await request(server())
        .delete(`/api/v1/documents/${doc}`)
        .set('Authorization', `Bearer ${alice.accessToken}`);
      expect(del.status).toBe(200);

      for (const res of [
        await requestOcr(ctx.app, alice, doc, { forceReprocess: true }),
        await getOcrStatus(ctx.app, alice, doc),
        await getOcrResults(ctx.app, alice, doc),
        await retryOcr(ctx.app, alice, doc),
      ]) {
        expect(res.status).toBe(404);
        expectErrorEnvelope(res.body, 'DOCUMENT_NOT_FOUND');
      }
      // Historical results are retained in the database (soft delete).
      expect(
        await ctx.prisma.ocrJob.count({ where: { documentId: doc } }),
      ).toBe(1);
    });

    it('a document without a completed upload (DRAFT) cannot be processed', async () => {
      const { id } = await createDocument(ctx.app, alice, {
        title: 'Draft only',
      });
      const res = await requestOcr(ctx.app, alice, id);
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'OCR_DOCUMENT_NOT_READY');
    });

    it('a document that is no longer READY (e.g. FAILED) cannot be processed', async () => {
      const doc = await uploadFixture(ctx.app, alice, 'text.pdf');
      await ctx.prisma.document.update({
        where: { id: doc },
        data: { status: 'FAILED' },
      });
      const res = await requestOcr(ctx.app, alice, doc);
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'OCR_DOCUMENT_NOT_READY');
    });

    it('status/results answer OCR_NOT_FOUND before any job exists', async () => {
      const doc = await uploadFixture(ctx.app, alice, 'text.pdf');
      const status = await getOcrStatus(ctx.app, alice, doc);
      expect(status.status).toBe(404);
      expectErrorEnvelope(status.body, 'OCR_NOT_FOUND');
      const results = await getOcrResults(ctx.app, alice, doc);
      expect(results.status).toBe(404);
      expectErrorEnvelope(results.body, 'OCR_NOT_FOUND');
      const retry = await retryOcr(ctx.app, alice, doc);
      expect(retry.status).toBe(404);
      expectErrorEnvelope(retry.body, 'OCR_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  describe('input validation', () => {
    it.each([
      ['unknown language', { language: 'xyz' }, 'OCR_UNSUPPORTED_LANGUAGE'],
      [
        'not installed language',
        { language: 'rus' },
        'OCR_UNSUPPORTED_LANGUAGE',
      ],
      [
        'too many languages',
        { language: 'ind+eng+msa+deu' },
        'OCR_UNSUPPORTED_LANGUAGE',
      ],
      ['malformed language', { language: 'eng; rm -rf /' }, 'VALIDATION_ERROR'],
      ['path-like language', { language: '../eng' }, 'VALIDATION_ERROR'],
      ['numeric language', { language: 123 }, 'VALIDATION_ERROR'],
      [
        'non-boolean forceReprocess',
        { forceReprocess: 'yes' },
        'VALIDATION_ERROR',
      ],
      [
        'client-controlled userId',
        { userId: randomUUID() },
        'VALIDATION_ERROR',
      ],
      [
        'client-controlled storageKey',
        { storageKey: 'users/x/y' },
        'VALIDATION_ERROR',
      ],
      ['client-controlled status', { status: 'COMPLETED' }, 'VALIDATION_ERROR'],
    ])('rejects %s', async (_name, body, code) => {
      const res = await requestOcr(ctx.app, alice, aliceDoc, body);
      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, code);
    });

    it('lists the available languages in the unsupported-language error', async () => {
      const res = await requestOcr(ctx.app, alice, aliceDoc, {
        language: 'xyz',
      });
      expect(res.body.message).toContain('ind');
      expect(res.body.message).toContain('eng');
    });

    it('rejects invalid result pagination', async () => {
      for (const query of [
        { limit: 51 },
        { limit: 0 },
        { page: 0 },
        { pageNumber: 0 },
        { jobId: 'nope' },
      ]) {
        const res = await getOcrResults(ctx.app, alice, aliceDoc, query);
        expect(res.status).toBe(400);
        expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Duplicate-job policy & reprocessing
  // ---------------------------------------------------------------------------

  describe('duplicate jobs and reprocessing', () => {
    it('returns the existing finished job (200) instead of repeating the work', async () => {
      const before = await ctx.prisma.ocrJob.count({
        where: { documentId: aliceDoc },
      });
      const res = await requestOcr(ctx.app, alice, aliceDoc, {});
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(aliceJobId);
      expect(res.body.message).toContain('forceReprocess');
      expect(
        await ctx.prisma.ocrJob.count({ where: { documentId: aliceDoc } }),
      ).toBe(before);
    });

    it('concurrent requests create exactly one active job', async () => {
      const doc = await uploadFixture(ctx.app, alice, 'scanned.pdf');
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => requestOcr(ctx.app, alice, doc, {})),
      );
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 202)).toHaveLength(1);
      expect(statuses.filter((s) => s === 200)).toHaveLength(5);
      const ids = new Set(responses.map((r) => r.body.data.id));
      expect(ids.size).toBe(1);
      expect(
        await ctx.prisma.ocrJob.count({ where: { documentId: doc } }),
      ).toBe(1);
      await waitForOcr(ctx.app, alice, doc);
    });

    it('a different language while a job is active is refused with 409', async () => {
      const doc = await uploadFixture(ctx.app, alice, 'scanned.pdf');
      const first = await requestOcr(ctx.app, alice, doc, { language: 'eng' });
      expect(first.status).toBe(202);
      const second = await requestOcr(ctx.app, alice, doc, { language: 'ind' });
      // Either still active (409) or already finished (then a new job is fine).
      if (second.status === 409) {
        expectErrorEnvelope(second.body, 'OCR_ALREADY_PROCESSING');
      } else {
        expect(second.status).toBe(202);
      }
      await waitForOcr(ctx.app, alice, doc);
    });

    it('forceReprocess creates a new job and keeps the previous results intact', async () => {
      const res = await requestOcr(ctx.app, alice, aliceDoc, {
        forceReprocess: true,
      });
      expect(res.status).toBe(202);
      expect(res.body.data.id).not.toBe(aliceJobId);
      const job = await waitForOcr(ctx.app, alice, aliceDoc);
      expect(job.id).toBe(res.body.data.id);
      expect(job.status).toBe(OcrJobStatus.COMPLETED);

      const jobs = await ctx.prisma.ocrJob.findMany({
        where: { documentId: aliceDoc },
      });
      expect(jobs).toHaveLength(2);
      const oldPages = await ctx.prisma.ocrPage.count({
        where: { ocrJobId: aliceJobId },
      });
      expect(oldPages).toBe(3);
      // The old job stays readable by id; the latest is the default.
      const old = await getOcrResults(ctx.app, alice, aliceDoc, {
        jobId: aliceJobId,
      });
      expect(old.status).toBe(200);
      expect(old.body.data.jobId).toBe(aliceJobId);
      const latest = await getOcrResults(ctx.app, alice, aliceDoc);
      expect(latest.body.data.jobId).toBe(job.id);
      aliceJobId = job.id;
    });

    it('a different language creates a separate job while the finished one remains', async () => {
      const res = await requestOcr(ctx.app, alice, aliceDoc, {
        language: 'eng',
      });
      expect(res.status).toBe(202);
      expect(res.body.data.language).toBe('eng');
      await waitForOcr(ctx.app, alice, aliceDoc);
    });

    it('enforces the per-document job limit', async () => {
      const doc = await uploadFixture(ctx.app, alice, 'text.pdf');
      const max = Number(process.env.OCR_MAX_JOBS_PER_DOCUMENT);
      for (let i = 0; i < max; i += 1) {
        const res = await requestOcr(ctx.app, alice, doc, {
          forceReprocess: true,
        });
        expect(res.status).toBe(202);
        await waitForOcr(ctx.app, alice, doc);
      }
      const res = await requestOcr(ctx.app, alice, doc, {
        forceReprocess: true,
      });
      expect(res.status).toBe(429);
      expectErrorEnvelope(res.body, 'OCR_TOO_MANY_JOBS');
    });

    it('enforces the per-user active job limit', async () => {
      const max = Number(process.env.OCR_MAX_ACTIVE_JOBS_PER_USER);
      const carol = await registerUser(ctx.app, { name: 'Carol' });
      const docs: string[] = [];
      for (let i = 0; i < max + 1; i += 1) {
        docs.push(await uploadFixture(ctx.app, carol, 'text.pdf'));
      }
      // Hold the jobs in QUEUED by pointing them at a never-processed state:
      // create rows directly (as the API would) so the worker race is irrelevant.
      await ctx.prisma.ocrJob.createMany({
        data: docs.slice(0, max).map((documentId) => ({
          documentId,
          userId: carol.userId,
          language: 'ind+eng',
          status: OcrJobStatus.QUEUED,
          maxAttempts: 2,
        })),
      });
      const res = await requestOcr(ctx.app, carol, docs[max], {});
      expect(res.status).toBe(429);
      expectErrorEnvelope(res.body, 'OCR_TOO_MANY_JOBS');
      await ctx.prisma.ocrJob.deleteMany({ where: { userId: carol.userId } });
    });
  });

  // ---------------------------------------------------------------------------
  // Results
  // ---------------------------------------------------------------------------

  describe('results', () => {
    it('paginates page results deterministically and respects limits', async () => {
      const page1 = await getOcrResults(ctx.app, alice, aliceDoc, {
        limit: 2,
        page: 1,
      });
      expect(page1.status).toBe(200);
      expect(page1.body.data.pagination).toEqual({
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
      });
      expect(
        page1.body.data.pages.map((p: { pageNumber: number }) => p.pageNumber),
      ).toEqual([1, 2]);

      const page2 = await getOcrResults(ctx.app, alice, aliceDoc, {
        limit: 2,
        page: 2,
      });
      expect(
        page2.body.data.pages.map((p: { pageNumber: number }) => p.pageNumber),
      ).toEqual([3]);

      const single = await getOcrResults(ctx.app, alice, aliceDoc, {
        pageNumber: 2,
      });
      expect(single.body.data.pages).toHaveLength(1);
      expect(single.body.data.pages[0].pageNumber).toBe(2);
      expect(single.body.data.pages[0].text.toLowerCase()).toContain('bravo');

      const beyond = await getOcrResults(ctx.app, alice, aliceDoc, {
        page: 50,
      });
      expect(beyond.status).toBe(200);
      expect(beyond.body.data.pages).toEqual([]);
    });

    it('answers OCR_NOT_READY while the latest job is queued or processing', async () => {
      const doc = await uploadFixture(ctx.app, alice, 'text.pdf');
      await ctx.prisma.ocrJob.create({
        data: {
          documentId: doc,
          userId: alice.userId,
          language: 'eng',
          status: OcrJobStatus.PROCESSING,
          maxAttempts: 2,
          heartbeatAt: new Date(),
        },
      });
      const res = await getOcrResults(ctx.app, alice, doc);
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'OCR_NOT_READY');
      await ctx.prisma.ocrJob.deleteMany({ where: { documentId: doc } });
    });

    it('never exposes internal fields', async () => {
      const status = await getOcrStatus(ctx.app, alice, aliceDoc);
      expect(status.body.data).not.toHaveProperty('userId');
      expect(status.body.data).not.toHaveProperty('heartbeatAt');
      const results = await getOcrResults(ctx.app, alice, aliceDoc);
      expect(JSON.stringify(results.body)).not.toMatch(
        /storageKey|\/tmp\/|users\//,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Retry
  // ---------------------------------------------------------------------------

  describe('retry', () => {
    it('refuses to retry a COMPLETED job', async () => {
      const res = await retryOcr(ctx.app, alice, aliceDoc);
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'OCR_RETRY_NOT_ALLOWED');
    });

    it('refuses to retry a permanently failed job', async () => {
      const doc = await uploadFixture(ctx.app, alice, 'corrupt.pdf');
      await requestOcr(ctx.app, alice, doc);
      const job = await waitForOcr(ctx.app, alice, doc);
      expect(job.status).toBe(OcrJobStatus.FAILED);
      expect(job.errorCode).toBe('OCR_INVALID_FILE');
      const res = await retryOcr(ctx.app, alice, doc);
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'OCR_RETRY_NOT_ALLOWED');
      expect(res.body.message).toContain('OCR_INVALID_FILE');
    });

    it('retries a transiently failed job as a new job with the same language', async () => {
      const doc = await uploadFixture(ctx.app, alice, 'text.pdf');
      const failed = await ctx.prisma.ocrJob.create({
        data: {
          documentId: doc,
          userId: alice.userId,
          language: 'eng',
          status: OcrJobStatus.FAILED,
          errorCode: 'OCR_STORAGE_ERROR',
          errorMessage: 'The document could not be read from storage',
          maxAttempts: 2,
          attemptCount: 2,
          completedAt: new Date(),
        },
      });
      const res = await retryOcr(ctx.app, alice, doc);
      expect(res.status).toBe(202);
      expect(res.body.message).toBe('OCR retry queued');
      expect(res.body.data.id).not.toBe(failed.id);
      expect(res.body.data.language).toBe('eng');
      expect(res.body.data.attemptCount).toBe(0);
      const job = await waitForOcr(ctx.app, alice, doc);
      expect(job.status).toBe(OcrJobStatus.COMPLETED);
      // The failed job is kept as history.
      expect(
        await ctx.prisma.ocrJob.findUnique({ where: { id: failed.id } }),
      ).toMatchObject({
        status: OcrJobStatus.FAILED,
      });
      expect(ctx.logs.text).toContain('OCR_RETRY_REQUESTED');
    });
  });

  // ---------------------------------------------------------------------------
  // Envelope & logging hygiene
  // ---------------------------------------------------------------------------

  describe('envelope and logs', () => {
    it('success and error responses use the standard envelope with a request id', async () => {
      const ok = await getOcrStatus(ctx.app, alice, aliceDoc);
      expect(ok.body).toEqual({
        success: true,
        data: expect.any(Object),
        message: null,
        requestId: expect.any(String),
      });
      const err = await getOcrStatus(ctx.app, bob, aliceDoc);
      expect(err.body).toEqual({
        success: false,
        data: null,
        code: 'DOCUMENT_NOT_FOUND',
        message: expect.any(String),
        requestId: expect.any(String),
      });
    });

    it('extracted text never appears in the logs', () => {
      // Every fixture processed in this suite contains one of these tokens.
      expect(ctx.logs.text.toLowerCase()).not.toMatch(
        /alpha|bravo|charlie|quick brown|scanned page/,
      );
      expect(ctx.logs.text).not.toMatch(/X-Amz-Signature|X-Amz-Credential/);
      expect(ctx.logs.text).toContain('OCR_JOB_REQUESTED');
      expect(ctx.logs.text).toContain('OCR job completed');
    });
  });
});
