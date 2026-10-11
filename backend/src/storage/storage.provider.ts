/**
 * Object-storage abstraction consumed by the Documents module.
 *
 * Business logic only ever talks to this contract, never to an SDK. Any
 * S3-compatible service (AWS S3, Cloudflare R2, MinIO, RustFS, ...) is
 * served by `S3StorageProvider`; a different backend only needs a new
 * implementation registered in `StorageModule`.
 *
 * Keys are opaque server-generated strings (see `storage-key.ts`); the
 * provider never derives keys from client input.
 */
import { Readable } from 'node:stream';

export interface UploadUrlRequest {
  key: string;
  /** Exact MIME type the client must send; signed into the URL. */
  contentType: string;
  /** Exact byte length the client must send; signed into the URL. */
  contentLength: number;
  expiresInSeconds: number;
}

export interface DownloadUrlRequest {
  key: string;
  expiresInSeconds: number;
  /** Content-Type the storage service should return. */
  responseContentType?: string;
  /** `Content-Disposition` the storage service should return. */
  responseContentDisposition?: string;
}

export interface PresignedUrl {
  url: string;
  method: 'PUT' | 'GET';
  /** Headers the client must send verbatim (upload only). */
  headers: Record<string, string>;
  expiresAt: Date;
  expiresInSeconds: number;
}

export interface StoredObjectMetadata {
  /** Size in bytes as reported by the storage service. */
  size: number;
  contentType: string | null;
  /** ETag without surrounding quotes. */
  etag: string | null;
  lastModified: Date | null;
}

export interface StoredObjectStream {
  /** Object body. Consumers must fully consume or destroy it. */
  body: Readable;
  size: number | null;
  contentType: string | null;
}

export abstract class StorageProvider {
  /** Short-lived presigned PUT URL for a single-part upload. */
  abstract createUploadUrl(request: UploadUrlRequest): Promise<PresignedUrl>;

  /**
   * Server-side read of an object (Phase 3: OCR worker input). Never exposed
   * to clients; `null` when the object does not exist.
   */
  abstract getObjectStream(key: string): Promise<StoredObjectStream | null>;

  /** Short-lived presigned GET URL. */
  abstract createDownloadUrl(
    request: DownloadUrlRequest,
  ): Promise<PresignedUrl>;

  /** Metadata of the object, or `null` when it does not exist. */
  abstract headObject(key: string): Promise<StoredObjectMetadata | null>;

  abstract objectExists(key: string): Promise<boolean>;

  /** Idempotent: deleting a missing object is not an error. */
  abstract deleteObject(key: string): Promise<void>;

  /** True when the configured bucket is reachable with the credentials. */
  abstract isHealthy(): Promise<boolean>;
}
