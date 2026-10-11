import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { StorageProvider } from '../src/storage/storage.provider';
import {
  RegisteredUser,
  expectErrorEnvelope,
  registerUser,
} from './utils/auth-helpers';
import {
  completeUpload,
  createDocument,
  putToPresignedUrl,
  requestDownloadUrl,
  requestUploadUrl,
  samplePdf,
  samplePng,
  uploadFile,
} from './utils/document-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

const MAX_FILE_SIZE = Number(process.env.MAX_DOCUMENT_FILE_SIZE_BYTES);
// test-env.ts clears S3_PUBLIC_ENDPOINT, so presigned URLs are signed for the
// configured S3_ENDPOINT (localhost on a workstation, `storage` in Docker).
const STORAGE_ORIGIN = new URL(process.env.S3_ENDPOINT as string).origin;
const TEST_BUCKET = process.env.S3_BUCKET as string;
const presignedUrlFor = (bucket: string) =>
  expect.stringMatching(
    new RegExp(`^${escapeRegExp(`${STORAGE_ORIGIN}/${bucket}/`)}`),
  );

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('Document uploads & downloads (e2e, real object storage)', () => {
  let ctx: TestContext;
  let storage: StorageProvider;
  let alice: RegisteredUser;
  let bob: RegisteredUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    storage = ctx.app.get(StorageProvider);
    await resetDatabase(ctx.prisma);
    alice = await registerUser(ctx.app, { name: 'Alice' });
    bob = await registerUser(ctx.app, { name: 'Bob' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  const server = () => ctx.app.getHttpServer();
  const as = (user: RegisteredUser) => `Bearer ${user.accessToken}`;

  const validDeclaration = (size = 1024) => ({
    fileName: 'invoice.pdf',
    contentType: 'application/pdf',
    fileSize: size,
  });

  describe('POST /documents/:id/upload-url', () => {
    it('requires authentication', async () => {
      const doc = await createDocument(ctx.app, alice);
      const res = await request(server())
        .post(`/api/v1/documents/${doc.id}/upload-url`)
        .send(validDeclaration());

      expect(res.status).toBe(401);
      expectErrorEnvelope(res.body, 'AUTH_UNAUTHORIZED');
    });

    it('requires ownership', async () => {
      const doc = await createDocument(ctx.app, alice);
      const res = await requestUploadUrl(
        ctx.app,
        bob,
        doc.id,
        validDeclaration(),
      );

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'DOCUMENT_NOT_FOUND');
      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.status).toBe('DRAFT');
      expect(stored.storageKey).toBeNull();
    });

    it('issues a presigned PUT, server-generated key and moves the document to UPLOADING', async () => {
      const doc = await createDocument(ctx.app, alice, { title: 'Upload me' });
      ctx.logs.clear();

      const res = await requestUploadUrl(ctx.app, alice, doc.id, {
        fileName: '  ../../../etc/Rechnung März.pdf ',
        contentType: 'Application/PDF',
        fileSize: 2048,
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        uploadUrl: presignedUrlFor(TEST_BUCKET),
        method: 'PUT',
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': '2048',
        },
        expiresAt: expect.any(String),
        expiresInSeconds: 300,
        document: expect.objectContaining({
          id: doc.id,
          status: 'UPLOADING',
          mimeType: 'application/pdf',
          fileSize: 2048,
          originalName: 'Rechnung März.pdf',
        }),
      });
      expect(JSON.stringify(res.body)).not.toContain('storageKey');
      expect(JSON.stringify(res.body)).not.toContain(
        process.env.S3_SECRET_KEY as string,
      );

      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.storageKey).toMatch(
        new RegExp(
          `^users/${alice.userId}/documents/${doc.id}/[A-Za-z0-9_-]{32}$`,
        ),
      );
      expect(stored.storageKey).not.toContain('Rechnung');
      expect(stored.storageKey).not.toContain('..');
      expect(res.body.data.uploadUrl).toContain(stored.storageKey as string);

      // The presigned URL itself must never be logged.
      expect(ctx.logs.text).toContain('UPLOAD_URL_CREATED');
      expect(ctx.logs.text).not.toContain('X-Amz-Signature');
      expect(ctx.logs.text).not.toContain(stored.storageKey as string);
    });

    it('rejects an arbitrary storageKey or other server-controlled fields', async () => {
      const doc = await createDocument(ctx.app, alice);

      for (const extra of [
        { storageKey: 'users/another-user/private.pdf' },
        { key: '../x' },
        { userId: bob.userId },
        { status: 'READY' },
      ]) {
        const res = await requestUploadUrl(ctx.app, alice, doc.id, {
          ...validDeclaration(),
          ...extra,
        });
        expect(res.status).toBe(400);
        expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
      }

      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.storageKey).toBeNull();
      expect(stored.status).toBe('DRAFT');
    });

    it.each([
      ['application/x-msdownload', 415, 'UNSUPPORTED_FILE_TYPE'],
      ['text/html', 415, 'UNSUPPORTED_FILE_TYPE'],
      ['application/pdf; charset=binary', 200, null],
      ['image/svg+xml', 415, 'UNSUPPORTED_FILE_TYPE'],
    ])('content type %s → %s', async (contentType, status, code) => {
      const doc = await createDocument(ctx.app, alice);
      const res = await requestUploadUrl(ctx.app, alice, doc.id, {
        fileName: 'file.pdf',
        contentType,
        fileSize: 100,
      });

      expect(res.status).toBe(status);
      if (code) expectErrorEnvelope(res.body, code);
    });

    it('rejects an extension that contradicts the declared type', async () => {
      const doc = await createDocument(ctx.app, alice);
      const res = await requestUploadUrl(ctx.app, alice, doc.id, {
        fileName: 'photo.png',
        contentType: 'application/pdf',
        fileSize: 100,
      });

      expect(res.status).toBe(415);
      expectErrorEnvelope(res.body, 'UNSUPPORTED_FILE_TYPE');
    });

    it('rejects oversized, zero-byte, negative and non-integer sizes', async () => {
      const doc = await createDocument(ctx.app, alice);

      const oversized = await requestUploadUrl(ctx.app, alice, doc.id, {
        ...validDeclaration(MAX_FILE_SIZE + 1),
      });
      expect(oversized.status).toBe(413);
      expectErrorEnvelope(oversized.body, 'FILE_TOO_LARGE');

      for (const fileSize of [
        0,
        -1,
        1.5,
        '1024',
        Number.MAX_SAFE_INTEGER + 2,
      ]) {
        const res = await requestUploadUrl(ctx.app, alice, doc.id, {
          ...validDeclaration(),
          fileSize,
        });
        expect([400, 413]).toContain(res.status);
        expect(['VALIDATION_ERROR', 'FILE_TOO_LARGE']).toContain(res.body.code);
      }

      const exactMax = await requestUploadUrl(ctx.app, alice, doc.id, {
        ...validDeclaration(MAX_FILE_SIZE),
      });
      expect(exactMax.status).toBe(200);
    });

    it.each([
      ['empty', ''],
      ['dot', '.'],
      ['dot-dot', '..'],
      ['directory only', '../'],
      ['null byte', 'bad\u0000.pdf'],
      ['too long', `${'a'.repeat(300)}.pdf`],
      ['missing', undefined],
    ])('rejects a malformed file name (%s)', async (_label, fileName) => {
      const doc = await createDocument(ctx.app, alice);
      const res = await requestUploadUrl(ctx.app, alice, doc.id, {
        ...validDeclaration(),
        ...(fileName === undefined ? { fileName: undefined } : { fileName }),
      });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('allows a new upload URL while UPLOADING and removes the superseded object', async () => {
      const doc = await createDocument(ctx.app, alice);
      const first = await requestUploadUrl(
        ctx.app,
        alice,
        doc.id,
        validDeclaration(512),
      );
      const firstKey = (
        await ctx.prisma.document.findUniqueOrThrow({ where: { id: doc.id } })
      ).storageKey as string;
      const put = await putToPresignedUrl(first.body.data, samplePdf(512));
      expect(put.status).toBe(200);
      expect(await storage.objectExists(firstKey)).toBe(true);

      const second = await requestUploadUrl(
        ctx.app,
        alice,
        doc.id,
        validDeclaration(768),
      );
      expect(second.status).toBe(200);
      const secondKey = (
        await ctx.prisma.document.findUniqueOrThrow({ where: { id: doc.id } })
      ).storageKey as string;
      expect(secondKey).not.toBe(firstKey);
      expect(await storage.objectExists(firstKey)).toBe(false);
    });

    it('refuses a new upload for a READY document', async () => {
      const doc = await createDocument(ctx.app, alice);
      await uploadFile(ctx.app, alice, doc.id);

      const res = await requestUploadUrl(
        ctx.app,
        alice,
        doc.id,
        validDeclaration(),
      );

      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'INVALID_UPLOAD');
    });
  });

  describe('presigned PUT enforcement by the storage service', () => {
    it('accepts exactly the declared body and rejects deviations', async () => {
      const doc = await createDocument(ctx.app, alice);
      const res = await requestUploadUrl(
        ctx.app,
        alice,
        doc.id,
        validDeclaration(1024),
      );
      const presigned = res.body.data;

      const wrongType = await putToPresignedUrl(presigned, samplePdf(1024), {
        'Content-Type': 'text/html',
      });
      expect(wrongType.status).toBeGreaterThanOrEqual(400);

      const wrongSize = await putToPresignedUrl(
        {
          uploadUrl: presigned.uploadUrl,
          headers: { 'Content-Type': 'application/pdf' },
        },
        samplePdf(2048),
      );
      expect(wrongSize.status).toBeGreaterThanOrEqual(400);

      const tampered = await putToPresignedUrl(
        {
          uploadUrl: presigned.uploadUrl.replace(
            /X-Amz-Signature=[0-9a-f]{8}/,
            'X-Amz-Signature=deadbeef',
          ),
          headers: presigned.headers,
        },
        samplePdf(1024),
      );
      expect(tampered.status).toBe(403);

      const ok = await putToPresignedUrl(presigned, samplePdf(1024));
      expect(ok.status).toBe(200);
    });

    it('the bucket denies anonymous reads of uploaded objects', async () => {
      const doc = await createDocument(ctx.app, alice);
      await uploadFile(ctx.app, alice, doc.id);
      const key = (
        await ctx.prisma.document.findUniqueOrThrow({ where: { id: doc.id } })
      ).storageKey as string;

      const anonymous = await fetch(
        `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/${key}`,
      );
      expect([401, 403]).toContain(anonymous.status);
    });
  });

  describe('POST /documents/:id/upload-complete', () => {
    it('does not mark a document READY when nothing was uploaded', async () => {
      const doc = await createDocument(ctx.app, alice);
      await requestUploadUrl(ctx.app, alice, doc.id, validDeclaration());

      const res = await completeUpload(ctx.app, alice, doc.id);

      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'UPLOAD_NOT_FOUND');
      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.status).toBe('UPLOADING');

      const download = await requestDownloadUrl(ctx.app, alice, doc.id);
      expect(download.status).toBe(409);
      expectErrorEnvelope(download.body, 'UPLOAD_NOT_READY');
    });

    it('rejects completion when no upload is in progress', async () => {
      const doc = await createDocument(ctx.app, alice);
      const res = await completeUpload(ctx.app, alice, doc.id);

      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'INVALID_UPLOAD');
    });

    it('verifies the object and marks the document READY (idempotent)', async () => {
      const doc = await createDocument(ctx.app, alice, {
        title: 'Complete me',
      });
      const file = samplePdf(1500);
      const urlRes = await requestUploadUrl(ctx.app, alice, doc.id, {
        fileName: 'scan.pdf',
        contentType: 'application/pdf',
        fileSize: file.length,
      });
      const put = await putToPresignedUrl(urlRes.body.data, file);
      expect(put.status).toBe(200);
      ctx.logs.clear();

      const res = await completeUpload(ctx.app, alice, doc.id, {
        etag: put.etag,
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: doc.id,
        status: 'READY',
        mimeType: 'application/pdf',
        fileSize: 1500,
        originalName: 'scan.pdf',
      });
      expect(ctx.logs.text).toContain('UPLOAD_COMPLETED');

      const again = await completeUpload(ctx.app, alice, doc.id);
      expect(again.status).toBe(200);
      expect(again.body.data.status).toBe('READY');
    });

    it('lets concurrent completions converge on READY exactly once', async () => {
      const doc = await createDocument(ctx.app, alice);
      const file = samplePdf(600);
      const urlRes = await requestUploadUrl(ctx.app, alice, doc.id, {
        ...validDeclaration(file.length),
      });
      await putToPresignedUrl(urlRes.body.data, file);
      ctx.logs.clear();

      const results = await Promise.all([
        completeUpload(ctx.app, alice, doc.id),
        completeUpload(ctx.app, alice, doc.id),
        completeUpload(ctx.app, alice, doc.id),
      ]);

      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(ctx.logs.text.match(/UPLOAD_COMPLETED/g)).toHaveLength(1);
    });

    it('rejects a mismatching etag and marks the upload FAILED', async () => {
      const doc = await createDocument(ctx.app, alice);
      const file = samplePdf(700);
      const urlRes = await requestUploadUrl(ctx.app, alice, doc.id, {
        ...validDeclaration(file.length),
      });
      await putToPresignedUrl(urlRes.body.data, file);
      const key = (
        await ctx.prisma.document.findUniqueOrThrow({ where: { id: doc.id } })
      ).storageKey as string;

      const res = await completeUpload(ctx.app, alice, doc.id, {
        etag: '"00000000000000000000000000000000"',
      });

      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'INVALID_UPLOAD');
      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.status).toBe('FAILED');
      expect(await storage.objectExists(key)).toBe(false);
      expect(ctx.logs.text).toContain('UPLOAD_REJECTED');

      // A FAILED document can start over.
      const retry = await requestUploadUrl(
        ctx.app,
        alice,
        doc.id,
        validDeclaration(),
      );
      expect(retry.status).toBe(200);
      expect(retry.body.data.document.status).toBe('UPLOADING');
    });

    it('rejects an object whose size differs from the declaration', async () => {
      // Simulate a storage backend that did not enforce the signed length by
      // writing a different object under the same key through the provider.
      const doc = await createDocument(ctx.app, alice);
      await requestUploadUrl(ctx.app, alice, doc.id, validDeclaration(1024));
      const key = (
        await ctx.prisma.document.findUniqueOrThrow({ where: { id: doc.id } })
      ).storageKey as string;
      const sneaky = await storage.createUploadUrl({
        key,
        contentType: 'application/pdf',
        contentLength: 10,
        expiresInSeconds: 60,
      });
      const put = await putToPresignedUrl(
        { uploadUrl: sneaky.url, headers: sneaky.headers },
        Buffer.from('0123456789'),
      );
      expect(put.status).toBe(200);

      const res = await completeUpload(ctx.app, alice, doc.id);

      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'INVALID_UPLOAD');
      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.status).toBe('FAILED');
      expect(await storage.objectExists(key)).toBe(false);
    });

    it("cannot complete another user's upload", async () => {
      const doc = await createDocument(ctx.app, alice);
      const file = samplePdf(300);
      const urlRes = await requestUploadUrl(ctx.app, alice, doc.id, {
        ...validDeclaration(file.length),
      });
      await putToPresignedUrl(urlRes.body.data, file);

      const res = await completeUpload(ctx.app, bob, doc.id);

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'DOCUMENT_NOT_FOUND');
      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.status).toBe('UPLOADING');
    });

    it('rejects a malformed etag', async () => {
      const doc = await createDocument(ctx.app, alice);
      const res = await completeUpload(ctx.app, alice, doc.id, {
        etag: 'not an etag!',
      });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });
  });

  describe('GET /documents/:id/download-url', () => {
    it('returns a short-lived presigned GET that serves the exact bytes', async () => {
      const doc = await createDocument(ctx.app, alice, {
        title: 'Download me',
      });
      const file = samplePng(900);
      await uploadFile(
        ctx.app,
        alice,
        doc.id,
        file,
        'Foto März.png',
        'image/png',
      );
      ctx.logs.clear();

      const res = await requestDownloadUrl(ctx.app, alice, doc.id);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        downloadUrl: presignedUrlFor(TEST_BUCKET),
        method: 'GET',
        expiresAt: expect.any(String),
        expiresInSeconds: 60,
        fileName: 'Foto März.png',
        contentType: 'image/png',
        fileSize: 900,
      });
      const url = new URL(res.body.data.downloadUrl);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
      expect(ctx.logs.text).toContain('DOWNLOAD_URL_CREATED');
      expect(ctx.logs.text).not.toContain('X-Amz-Signature');

      const download = await fetch(res.body.data.downloadUrl);
      expect(download.status).toBe(200);
      expect(download.headers.get('content-type')).toBe('image/png');
      expect(download.headers.get('content-disposition')).toContain(
        "filename*=UTF-8''Foto%20M%C3%A4rz.png",
      );
      expect(Buffer.from(await download.arrayBuffer()).equals(file)).toBe(true);
    });

    it('requires authentication and ownership', async () => {
      const doc = await createDocument(ctx.app, alice);
      await uploadFile(ctx.app, alice, doc.id);

      const anonymous = await request(server()).get(
        `/api/v1/documents/${doc.id}/download-url`,
      );
      expect(anonymous.status).toBe(401);

      const idor = await requestDownloadUrl(ctx.app, bob, doc.id);
      expect(idor.status).toBe(404);
      expectErrorEnvelope(idor.body, 'DOCUMENT_NOT_FOUND');
    });

    it('refuses documents that are not READY', async () => {
      const draft = await createDocument(ctx.app, alice);
      const res = await requestDownloadUrl(ctx.app, alice, draft.id);
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'UPLOAD_NOT_READY');
    });

    it('refuses a deleted document and the object stays private', async () => {
      const doc = await createDocument(ctx.app, alice);
      await uploadFile(ctx.app, alice, doc.id);
      const key = (
        await ctx.prisma.document.findUniqueOrThrow({ where: { id: doc.id } })
      ).storageKey as string;

      await request(server())
        .delete(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(alice))
        .expect(200);

      const res = await requestDownloadUrl(ctx.app, alice, doc.id);
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'DOCUMENT_NOT_FOUND');

      // Object retained for the clean-up job, but unreachable without a URL.
      expect(await storage.objectExists(key)).toBe(true);
      const anonymous = await fetch(
        `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/${key}`,
      );
      expect([401, 403]).toContain(anonymous.status);
    });

    it('returns not found for an unknown id', async () => {
      const res = await requestDownloadUrl(ctx.app, alice, randomUUID());
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'DOCUMENT_NOT_FOUND');
    });
  });

  describe('presign rate limiting', () => {
    const original = process.env.DOCUMENT_PRESIGN_RATE_LIMIT;

    afterEach(async () => {
      process.env.DOCUMENT_PRESIGN_RATE_LIMIT = original;
      await ctx.redis.getClient().flushdb();
    });

    it('throttles upload-url generation independently of the global limit', async () => {
      process.env.DOCUMENT_PRESIGN_RATE_LIMIT = '2';
      await ctx.redis.getClient().flushdb();
      const doc = await createDocument(ctx.app, alice);

      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await requestUploadUrl(
          ctx.app,
          alice,
          doc.id,
          validDeclaration(),
        );
        statuses.push(res.status);
      }
      expect(statuses).toEqual([200, 200, 429]);

      // Other document endpoints are unaffected.
      const get = await request(server())
        .get(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(alice));
      expect(get.status).toBe(200);
    });
  });

  it('never writes presigned URLs, keys or storage secrets to the log', async () => {
    ctx.logs.clear();
    const doc = await createDocument(ctx.app, alice);
    const urlRes = await requestUploadUrl(
      ctx.app,
      alice,
      doc.id,
      validDeclaration(256),
    );
    await putToPresignedUrl(urlRes.body.data, samplePdf(256));
    await completeUpload(ctx.app, alice, doc.id);
    const dl = await requestDownloadUrl(ctx.app, alice, doc.id);
    const key = (
      await ctx.prisma.document.findUniqueOrThrow({ where: { id: doc.id } })
    ).storageKey as string;

    const text = ctx.logs.text;
    expect(text).toContain('UPLOAD_URL_CREATED');
    expect(text).toContain('UPLOAD_COMPLETED');
    expect(text).toContain('DOWNLOAD_URL_CREATED');
    expect(text).not.toContain(urlRes.body.data.uploadUrl);
    expect(text).not.toContain(dl.body.data.downloadUrl);
    expect(text).not.toContain('X-Amz-Signature');
    expect(text).not.toContain(key);
    expect(text).not.toContain(process.env.S3_SECRET_KEY as string);
    expect(text).not.toContain(alice.accessToken);
  });
});
