import { OcrJobStatus, OcrPageStatus } from '@prisma/client';
import { readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RegisteredUser, registerUser } from './utils/auth-helpers';
import {
  EXPECTED,
  expectKeywords,
  fixture,
  getOcrResults,
  requestOcr,
  uploadFixture,
  waitForOcr,
} from './utils/ocr-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

/**
 * End-to-end OCR through the HTTP API against the real engine: files are
 * uploaded to private object storage, the BullMQ worker embedded in the test
 * app downloads and processes them with Poppler + Tesseract, results are read
 * back from PostgreSQL through the results endpoint.
 */
describe('OCR pipeline (e2e, real Tesseract + Poppler)', () => {
  jest.setTimeout(120_000);

  let ctx: TestContext;
  let alice: RegisteredUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    alice = await registerUser(ctx.app, { name: 'Alice' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function processFixture(
    name: string,
    body: Record<string, unknown> = {},
  ) {
    const documentId = await uploadFixture(ctx.app, alice, name);
    const accepted = await requestOcr(ctx.app, alice, documentId, body);
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({
      success: true,
      message: 'OCR job queued',
      data: { status: OcrJobStatus.QUEUED, processedPages: 0 },
    });
    const job = await waitForOcr(ctx.app, alice, documentId);
    const results = await getOcrResults(ctx.app, alice, documentId, {
      limit: 50,
    });
    expect(results.status).toBe(200);
    return {
      documentId,
      job,
      results: results.body.data,
      accepted: accepted.body.data,
    };
  }

  // ---------------------------------------------------------------------------
  // Native PDF text
  // ---------------------------------------------------------------------------

  it('extracts native text from a one-page PDF without OCR', async () => {
    const { job, results } = await processFixture('text.pdf');

    expect(job.status).toBe(OcrJobStatus.COMPLETED);
    expect(job.extractionMethod).toBe('NATIVE_TEXT');
    expect(job.totalPages).toBe(1);
    expect(job.processedPages).toBe(1);
    expect(job.failedPages).toBe(0);
    expect(job.progress).toBe(100);
    expect(job.errorCode).toBeNull();
    expect(job.startedAt).not.toBeNull();
    expect(job.completedAt).not.toBeNull();

    expect(results.pages).toHaveLength(1);
    const [page] = results.pages;
    expect(page.pageNumber).toBe(1);
    expect(page.status).toBe(OcrPageStatus.COMPLETED);
    expect(page.method).toBe('NATIVE_TEXT');
    // Native text carries no OCR confidence; never fabricated.
    expect(page.confidence).toBeNull();
    expect(page.truncated).toBe(false);
    expectKeywords(page.text, EXPECTED['text.pdf'].keywords![0]);
  });

  it('preserves page order and numbering across a multi-page PDF', async () => {
    const { job, results, documentId } =
      await processFixture('text-3pages.pdf');

    expect(job.status).toBe(OcrJobStatus.COMPLETED);
    expect(job.totalPages).toBe(3);
    expect(
      results.pages.map((p: { pageNumber: number }) => p.pageNumber),
    ).toEqual([1, 2, 3]);
    EXPECTED['text-3pages.pdf'].keywords!.forEach((keywords, index) => {
      expectKeywords(results.pages[index].text, keywords);
    });
    // Page 2 text must not leak into page 1 or 3.
    expect(results.pages[0].text.toLowerCase()).not.toContain('bravo');
    expect(results.pages[2].text.toLowerCase()).not.toContain('bravo');

    const document = await ctx.prisma.document.findUnique({
      where: { id: documentId },
    });
    expect(document?.pageCount).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Scanned PDF
  // ---------------------------------------------------------------------------

  it('renders and OCRs a scanned PDF page by page and cleans up temp files', async () => {
    const tmpRoot = path.join(os.tmpdir(), 'docuai-ocr');
    const before = safeList(tmpRoot);

    const { job, results } = await processFixture('scanned.pdf');

    expect(job.status).toBe(OcrJobStatus.COMPLETED);
    expect(job.extractionMethod).toBe('OCR');
    expect(job.totalPages).toBe(2);
    expect(job.processedPages).toBe(2);
    expect(results.pages).toHaveLength(2);
    results.pages.forEach(
      (
        page: { method: string; confidence: number | null; status: string },
        index: number,
      ) => {
        expect(page.status).toBe(OcrPageStatus.COMPLETED);
        expect(page.method).toBe('OCR');
        expect(page.confidence).toBeGreaterThan(50);
        expect(page.confidence).toBeLessThanOrEqual(100);
        expectKeywords(
          results.pages[index].text,
          EXPECTED['scanned.pdf'].keywords![index],
        );
      },
    );
    expect(results.pages[0].text.toLowerCase()).not.toContain('second');

    // Job work directories are removed after completion.
    expect(safeList(tmpRoot)).toEqual(before);
  });

  // ---------------------------------------------------------------------------
  // Mixed PDF
  // ---------------------------------------------------------------------------

  it('uses native text for text pages and OCR for scanned pages of a mixed PDF', async () => {
    const { job, results } = await processFixture('mixed.pdf');

    expect(job.status).toBe(OcrJobStatus.COMPLETED);
    expect(job.extractionMethod).toBe('MIXED');
    expect(results.pages).toHaveLength(2);

    const [native, scanned] = results.pages;
    expect(native.pageNumber).toBe(1);
    expect(native.method).toBe('NATIVE_TEXT');
    expect(native.confidence).toBeNull();
    expectKeywords(native.text, EXPECTED['mixed.pdf'].keywords![0]);

    expect(scanned.pageNumber).toBe(2);
    expect(scanned.method).toBe('OCR');
    expect(scanned.confidence).not.toBeNull();
    expectKeywords(scanned.text, EXPECTED['mixed.pdf'].keywords![1]);

    // No duplicated full-page text: each marker appears on exactly one page.
    expect(native.text.toLowerCase()).not.toContain('second');
    expect(scanned.text.toLowerCase()).not.toContain('first');
    expect(occurrences(native.text.toLowerCase(), 'native text page')).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Images
  // ---------------------------------------------------------------------------

  it.each(['printed.png', 'printed.jpg', 'printed.webp'])(
    'OCRs a %s image with the requested language',
    async (name) => {
      const { job, results } = await processFixture(name, { language: 'eng' });

      expect(job.status).toBe(OcrJobStatus.COMPLETED);
      expect(job.language).toBe('eng');
      expect(job.extractionMethod).toBe('OCR');
      expect(job.totalPages).toBe(1);
      expect(results.pages).toHaveLength(1);
      const [page] = results.pages;
      expect(page.pageNumber).toBe(1);
      expect(page.status).toBe(OcrPageStatus.COMPLETED);
      expect(page.confidence).toBeGreaterThan(50);
      expectKeywords(page.text, EXPECTED[name].keywords![0]);

      const stored = await ctx.prisma.ocrPage.findMany({
        where: { ocrJobId: job.id },
      });
      expect(stored).toHaveLength(1);
      expect(stored[0].text).toBe(page.text);
    },
  );

  it('completes a blank image as an EMPTY page instead of failing', async () => {
    const { job, results } = await processFixture('blank.png');

    expect(job.status).toBe(OcrJobStatus.COMPLETED);
    expect(results.pages).toHaveLength(1);
    expect(results.pages[0]).toMatchObject({
      pageNumber: 1,
      status: OcrPageStatus.EMPTY,
      method: 'OCR',
      text: '',
      confidence: null,
      charCount: 0,
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid / spoofed / oversized input
  // ---------------------------------------------------------------------------

  it('fails safely on a corrupt PDF with a permanent error code', async () => {
    const { job, results } = await processFixture('corrupt.pdf');

    expect(job.status).toBe(OcrJobStatus.FAILED);
    expect(job.errorCode).toBe('OCR_INVALID_FILE');
    expect(job.errorMessage).not.toMatch(/\/tmp|Syntax Error|pdfinfo/);
    expect(results.status).toBe(OcrJobStatus.FAILED);
    expect(results.pages).toEqual([]);
  });

  it('fails safely on a corrupt PNG', async () => {
    const { job } = await processFixture('corrupt.png');

    expect(job.status).toBe(OcrJobStatus.FAILED);
    expect(['OCR_INVALID_FILE', 'OCR_PROCESSING_FAILED']).toContain(
      job.errorCode,
    );
    expect(job.attemptCount).toBeGreaterThanOrEqual(1);
  });

  it('rejects a file whose bytes do not match its declared MIME type', async () => {
    // Declared as PNG at upload time (Phase 2 only checks the Content-Type
    // header), but the bytes are plain text.
    const documentId = await uploadFixture(
      ctx.app,
      alice,
      'not-a-document.txt',
      {
        contentType: 'image/png',
        fileName: 'spoofed.png',
      },
    );
    const accepted = await requestOcr(ctx.app, alice, documentId);
    expect(accepted.status).toBe(202);
    const job = await waitForOcr(ctx.app, alice, documentId);

    expect(job.status).toBe(OcrJobStatus.FAILED);
    expect(job.errorCode).toBe('OCR_UNSUPPORTED_FILE_TYPE');
    // Permanent: exactly one attempt, no automatic retry.
    expect(job.attemptCount).toBe(1);
  });

  it('rejects a JPEG uploaded under a PDF content type', async () => {
    const documentId = await uploadFixture(ctx.app, alice, 'printed.jpg', {
      contentType: 'application/pdf',
      fileName: 'photo.pdf',
      bytes: fixture('printed.jpg'),
    });
    await requestOcr(ctx.app, alice, documentId);
    const job = await waitForOcr(ctx.app, alice, documentId);
    expect(job.status).toBe(OcrJobStatus.FAILED);
    expect(job.errorCode).toBe('OCR_UNSUPPORTED_FILE_TYPE');
  });

  it('fails a PDF that exceeds the configured page limit', async () => {
    const { job, documentId } = await processFixture('text-6pages.pdf');

    expect(job.status).toBe(OcrJobStatus.FAILED);
    expect(job.errorCode).toBe('OCR_PAGE_LIMIT_EXCEEDED');
    expect(job.totalPages).toBeNull();
    expect(
      await ctx.prisma.ocrPage.count({ where: { ocrJobId: job.id } }),
    ).toBe(0);

    // The limit is now known on the document: a new request is refused upfront.
    const again = await requestOcr(ctx.app, alice, documentId, {
      forceReprocess: true,
    });
    expect(again.status).toBe(202);
    const retried = await waitForOcr(ctx.app, alice, documentId);
    expect(retried.errorCode).toBe('OCR_PAGE_LIMIT_EXCEEDED');
  });

  it('truncates per-page text at the limit and stops storing text at the document limit', async () => {
    const { job, results } = await processFixture('long-text.pdf');

    expect(job.status).toBe(OcrJobStatus.COMPLETED);
    expect(results.pages).toHaveLength(2);
    const [first, second] = results.pages;
    // OCR_MAX_TEXT_PER_PAGE=1000 in the test env.
    expect(first.truncated).toBe(true);
    expect(first.charCount).toBe(1000);
    expect(Array.from(first.text as string)).toHaveLength(1000);
    expectKeywords(first.text, EXPECTED['long-text.pdf'].keywords![0]);
    // Document budget 2500: page 2 gets the remaining 1 500 characters at most.
    expect(second.truncated).toBe(true);
    expect(second.charCount).toBeLessThanOrEqual(1500);
    expect(first.charCount + second.charCount).toBeLessThanOrEqual(2500);
  });
});

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
