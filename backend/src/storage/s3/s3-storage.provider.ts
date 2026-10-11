import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, StorageConfig } from '../../config/configuration';
import { StorageException } from '../storage.errors';
import {
  DownloadUrlRequest,
  PresignedUrl,
  StorageProvider,
  StoredObjectMetadata,
  StoredObjectStream,
  UploadUrlRequest,
} from '../storage.provider';

interface S3LikeError {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

const NOT_FOUND_NAMES = new Set(['NotFound', 'NoSuchKey', 'NoSuchBucket']);

/**
 * `StorageProvider` for any S3-compatible API (AWS S3, Cloudflare R2, MinIO,
 * RustFS, ...).
 *
 * Two clients are kept on purpose: `client` talks to `S3_ENDPOINT` (the
 * address the API itself can reach, e.g. `http://storage:9000` inside Docker)
 * and `signingClient` targets `S3_PUBLIC_ENDPOINT` (the address clients can
 * reach, e.g. `http://localhost:9000`). SigV4 signs the `Host` header, so a
 * presigned URL is only valid for the host it was signed for.
 *
 * The bucket is never made public: no bucket policy or ACL is ever written,
 * and every URL handed out is a short-lived presigned URL.
 */
@Injectable()
export class S3StorageProvider extends StorageProvider implements OnModuleInit {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly config: StorageConfig;
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly signingClient: S3Client;

  constructor(configService: ConfigService<AppConfig, true>) {
    super();
    this.config = configService.get('storage', { infer: true });
    const { s3 } = this.config;
    this.bucket = s3.bucket;

    const base = {
      region: s3.region,
      forcePathStyle: s3.forcePathStyle,
      credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey },
    };
    this.client = new S3Client({
      ...base,
      ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
    });
    const publicEndpoint = s3.publicEndpoint ?? s3.endpoint;
    this.signingClient = publicEndpoint
      ? new S3Client({ ...base, endpoint: publicEndpoint })
      : this.client;
  }

  /**
   * Verifies the bucket at boot. A missing bucket is created outside
   * production (`S3_AUTO_CREATE_BUCKET`); in production a missing bucket is a
   * deployment error and aborts startup. Transient connectivity problems are
   * logged and surfaced through `/health` instead of crashing the process.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.logger.log('Object storage bucket is reachable');
      return;
    } catch (error) {
      if (!isNotFound(error)) {
        this.logger.error(
          `Object storage is unreachable at startup: ${describe(error)}`,
        );
        return;
      }
    }

    if (!this.config.autoCreateBucket) {
      throw new Error(
        'Configured object storage bucket does not exist and S3_AUTO_CREATE_BUCKET is disabled',
      );
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log('Created private object storage bucket');
    } catch (error) {
      // Another instance may have created it concurrently.
      if (!isAlreadyOwned(error)) {
        this.logger.error(
          `Failed to create object storage bucket: ${describe(error)}`,
        );
      }
    }
  }

  async createUploadUrl(request: UploadUrlRequest): Promise<PresignedUrl> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: request.key,
      ContentType: request.contentType,
      ContentLength: request.contentLength,
    });
    const url = await this.presign(
      command,
      request.expiresInSeconds,
      // Force both headers into the signature so the storage service itself
      // rejects uploads whose type or size deviate from what was declared.
      new Set(['content-type', 'content-length']),
    );
    return {
      url,
      method: 'PUT',
      headers: {
        'Content-Type': request.contentType,
        'Content-Length': String(request.contentLength),
      },
      ...expiry(request.expiresInSeconds),
    };
  }

  async createDownloadUrl(request: DownloadUrlRequest): Promise<PresignedUrl> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: request.key,
      ...(request.responseContentType
        ? { ResponseContentType: request.responseContentType }
        : {}),
      ...(request.responseContentDisposition
        ? { ResponseContentDisposition: request.responseContentDisposition }
        : {}),
    });
    const url = await this.presign(command, request.expiresInSeconds);
    return {
      url,
      method: 'GET',
      headers: {},
      ...expiry(request.expiresInSeconds),
    };
  }

  async headObject(key: string): Promise<StoredObjectMetadata | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: head.ContentLength ?? 0,
        contentType: head.ContentType ?? null,
        etag: head.ETag ? head.ETag.replace(/^"|"$/g, '') : null,
        lastModified: head.LastModified ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw this.wrap('headObject', error);
    }
  }

  async objectExists(key: string): Promise<boolean> {
    return (await this.headObject(key)) !== null;
  }

  async getObjectStream(key: string): Promise<StoredObjectStream | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.Body) return null;
      return {
        body: result.Body as Readable,
        size: result.ContentLength ?? null,
        contentType: result.ContentType ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw this.wrap('getObject', error);
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      if (isNotFound(error)) return;
      throw this.wrap('deleteObject', error);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch (error) {
      this.logger.warn(`Storage health check failed: ${describe(error)}`);
      return false;
    }
  }

  private async presign(
    command: PutObjectCommand | GetObjectCommand,
    expiresIn: number,
    signableHeaders?: Set<string>,
  ): Promise<string> {
    try {
      return await getSignedUrl(this.signingClient, command, {
        expiresIn,
        ...(signableHeaders ? { signableHeaders } : {}),
      });
    } catch (error) {
      throw this.wrap('presign', error);
    }
  }

  private wrap(operation: string, error: unknown): StorageException {
    // Operation + provider error name only; never the key, URL or credentials.
    this.logger.error(`Storage ${operation} failed: ${describe(error)}`);
    return new StorageException();
  }
}

function isNotFound(error: unknown): boolean {
  const e = error as S3LikeError;
  return (
    NOT_FOUND_NAMES.has(e?.name ?? '') || e?.$metadata?.httpStatusCode === 404
  );
}

function isAlreadyOwned(error: unknown): boolean {
  const name = (error as S3LikeError)?.name ?? '';
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}

function describe(error: unknown): string {
  const e = error as S3LikeError;
  const status = e?.$metadata?.httpStatusCode;
  return `${e?.name ?? 'Error'}${status ? ` (HTTP ${status})` : ''}: ${e?.message ?? 'unknown error'}`;
}

function expiry(expiresInSeconds: number): {
  expiresAt: Date;
  expiresInSeconds: number;
} {
  return {
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    expiresInSeconds,
  };
}
