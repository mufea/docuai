import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { normalizeForComparison } from '../../src/ocr/tools/text';
import { RegisteredUser } from './auth-helpers';
import { createDocument, uploadFile } from './document-helpers';

export const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures', 'ocr');

export interface FixtureExpectation {
  pages: number;
  /** Required keywords per page (normalised, lower-case). */
  keywords?: string[][];
}

export const EXPECTED: Record<string, FixtureExpectation> = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, 'expected.json'), 'utf8'),
) as Record<string, FixtureExpectation>;

export function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURE_DIR, name));
}

export function contentTypeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

/** Creates a document and uploads a fixture (or arbitrary bytes) as READY. */
export async function uploadFixture(
  app: INestApplication,
  user: RegisteredUser,
  name: string,
  options: { contentType?: string; bytes?: Buffer; fileName?: string } = {},
): Promise<string> {
  const { id: documentId } = await createDocument(app, user, {
    title: `OCR ${name}`,
  });
  await uploadFile(
    app,
    user,
    documentId,
    options.bytes ?? fixture(name),
    options.fileName ?? name,
    options.contentType ?? contentTypeFor(name),
  );
  return documentId;
}

const bearer = (user: RegisteredUser) => `Bearer ${user.accessToken}`;

export function requestOcr(
  app: INestApplication,
  user: RegisteredUser,
  documentId: string,
  body: Record<string, unknown> = {},
) {
  return request(app.getHttpServer())
    .post(`/api/v1/documents/${documentId}/ocr`)
    .set('Authorization', bearer(user))
    .send(body);
}

export function getOcrStatus(
  app: INestApplication,
  user: RegisteredUser,
  documentId: string,
) {
  return request(app.getHttpServer())
    .get(`/api/v1/documents/${documentId}/ocr`)
    .set('Authorization', bearer(user));
}

export function getOcrResults(
  app: INestApplication,
  user: RegisteredUser,
  documentId: string,
  query: Record<string, string | number> = {},
) {
  return request(app.getHttpServer())
    .get(`/api/v1/documents/${documentId}/ocr/results`)
    .query(query)
    .set('Authorization', bearer(user));
}

export function retryOcr(
  app: INestApplication,
  user: RegisteredUser,
  documentId: string,
) {
  return request(app.getHttpServer())
    .post(`/api/v1/documents/${documentId}/ocr/retry`)
    .set('Authorization', bearer(user));
}

const TERMINAL = new Set(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']);

export interface JobStatusBody {
  id: string;
  status: string;
  language: string;
  extractionMethod: string | null;
  totalPages: number | null;
  processedPages: number;
  failedPages: number;
  progress: number | null;
  attemptCount: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** Polls the status endpoint until the latest job is terminal. */
export async function waitForOcr(
  app: INestApplication,
  user: RegisteredUser,
  documentId: string,
  timeoutMs = 60_000,
): Promise<JobStatusBody> {
  const deadline = Date.now() + timeoutMs;
  let last: JobStatusBody | null = null;
  while (Date.now() < deadline) {
    const res = await getOcrStatus(app, user, documentId);
    if (res.status === 200) {
      last = res.body.data as JobStatusBody;
      if (TERMINAL.has(last.status)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `OCR job did not finish within ${timeoutMs} ms (last status: ${last ? JSON.stringify(last) : 'none'})`,
  );
}

/**
 * Asserts that every keyword occurs in the (normalised) text. OCR output is
 * compared loosely on purpose: we require the key tokens, not exact bytes.
 */
export function expectKeywords(text: string | null, keywords: string[]): void {
  const haystack = normalizeForComparison(text ?? '');
  const missing = keywords.filter((keyword) => !haystack.includes(keyword));
  if (missing.length > 0) {
    throw new Error(
      `Extracted text is missing ${JSON.stringify(missing)}; got: ${JSON.stringify(haystack)}`,
    );
  }
}
