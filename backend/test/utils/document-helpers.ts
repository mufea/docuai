import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { RegisteredUser } from './auth-helpers';

/** Minimal valid PDF header followed by padding; good enough for storage tests. */
export function samplePdf(size = 1024): Buffer {
  const header = Buffer.from('%PDF-1.4\n%DocuAI test fixture\n');
  const padding = Buffer.alloc(Math.max(0, size - header.length), 0x20);
  return Buffer.concat([header, padding]).subarray(0, size);
}

export function samplePng(size = 512): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  return Buffer.concat([
    signature,
    Buffer.alloc(Math.max(0, size - signature.length), 0),
  ]).subarray(0, size);
}

const bearer = (user: RegisteredUser) => `Bearer ${user.accessToken}`;

export async function createDocument(
  app: INestApplication,
  user: RegisteredUser,
  body: Record<string, unknown> = { title: 'Test document' },
): Promise<{ id: string; folderId: string | null; status: string }> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/documents')
    .set('Authorization', bearer(user))
    .send(body);
  if (res.status !== 201) {
    throw new Error(`createDocument failed: ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

export async function createFolder(
  app: INestApplication,
  user: RegisteredUser,
  name = 'Folder',
  parentId: string | null = null,
): Promise<{ id: string; name: string; parentId: string | null }> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/folders')
    .set('Authorization', bearer(user))
    .send(parentId ? { name, parentId } : { name });
  if (res.status !== 201) {
    throw new Error(`createFolder failed: ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

export interface UploadUrlResponse {
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
  expiresInSeconds: number;
  document: { id: string; status: string; fileSize: number | null };
}

export function requestUploadUrl(
  app: INestApplication,
  user: RegisteredUser,
  documentId: string,
  body: Record<string, unknown>,
) {
  return request(app.getHttpServer())
    .post(`/api/v1/documents/${documentId}/upload-url`)
    .set('Authorization', bearer(user))
    .send(body);
}

export function completeUpload(
  app: INestApplication,
  user: RegisteredUser,
  documentId: string,
  body: Record<string, unknown> = {},
) {
  return request(app.getHttpServer())
    .post(`/api/v1/documents/${documentId}/upload-complete`)
    .set('Authorization', bearer(user))
    .send(body);
}

export function requestDownloadUrl(
  app: INestApplication,
  user: RegisteredUser,
  documentId: string,
) {
  return request(app.getHttpServer())
    .get(`/api/v1/documents/${documentId}/download-url`)
    .set('Authorization', bearer(user));
}

/** PUTs `body` to a presigned URL exactly as a client would. */
export async function putToPresignedUrl(
  presigned: Pick<UploadUrlResponse, 'uploadUrl' | 'headers'>,
  body: Buffer,
  headerOverrides: Record<string, string> = {},
): Promise<{ status: number; etag: string | null }> {
  const res = await fetch(presigned.uploadUrl, {
    method: 'PUT',
    headers: { ...presigned.headers, ...headerOverrides },
    body,
    // @ts-expect-error node fetch requires duplex for streaming bodies
    duplex: 'half',
  });
  await res.arrayBuffer();
  return { status: res.status, etag: res.headers.get('etag') };
}

/** Uploads a file end-to-end and returns the READY document. */
export async function uploadFile(
  app: INestApplication,
  user: RegisteredUser,
  documentId: string,
  file: Buffer = samplePdf(),
  fileName = 'fixture.pdf',
  contentType = 'application/pdf',
): Promise<{ id: string; status: string; fileSize: number }> {
  const urlRes = await requestUploadUrl(app, user, documentId, {
    fileName,
    contentType,
    fileSize: file.length,
  });
  if (urlRes.status !== 200) {
    throw new Error(`upload-url failed: ${JSON.stringify(urlRes.body)}`);
  }
  const put = await putToPresignedUrl(urlRes.body.data, file);
  if (put.status < 200 || put.status >= 300) {
    throw new Error(`presigned PUT failed with HTTP ${put.status}`);
  }
  const done = await completeUpload(app, user, documentId, {});
  if (done.status !== 200) {
    throw new Error(`upload-complete failed: ${JSON.stringify(done.body)}`);
  }
  return done.body.data;
}
