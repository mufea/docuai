import { S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, StorageConfig } from '../../config/configuration';
import { StorageException } from '../storage.errors';
import { S3StorageProvider } from './s3-storage.provider';

function makeProvider(overrides: Partial<StorageConfig['s3']> = {}) {
  const storage: StorageConfig = {
    provider: 's3',
    s3: {
      endpoint: 'http://storage:9000',
      publicEndpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'docuai-private',
      accessKey: 'test-access-key',
      secretKey: 'test-secret-key-value',
      forcePathStyle: true,
      ...overrides,
    },
    uploadUrlTtlSeconds: 900,
    downloadUrlTtlSeconds: 300,
    autoCreateBucket: true,
  };
  const configService = {
    get: jest.fn().mockReturnValue(storage),
  } as unknown as ConfigService<AppConfig, true>;
  return new S3StorageProvider(configService);
}

describe('S3StorageProvider', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  describe('createUploadUrl', () => {
    it('signs a PUT for the public endpoint with content type and length bound', async () => {
      const provider = makeProvider();
      const key = 'users/u/documents/d/random';

      const presigned = await provider.createUploadUrl({
        key,
        contentType: 'application/pdf',
        contentLength: 1234,
        expiresInSeconds: 600,
      });

      const url = new URL(presigned.url);
      expect(url.origin).toBe('http://localhost:9000');
      expect(url.pathname).toBe(`/docuai-private/${key}`);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-length;content-type;host',
      );
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
      expect(presigned.url).not.toContain('test-secret-key-value');
      expect(presigned.method).toBe('PUT');
      expect(presigned.headers).toEqual({
        'Content-Type': 'application/pdf',
        'Content-Length': '1234',
      });
      expect(presigned.expiresInSeconds).toBe(600);
      expect(presigned.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('falls back to the internal endpoint when no public endpoint is set', async () => {
      const provider = makeProvider({ publicEndpoint: null });

      const presigned = await provider.createUploadUrl({
        key: 'k',
        contentType: 'image/png',
        contentLength: 1,
        expiresInSeconds: 60,
      });

      expect(new URL(presigned.url).origin).toBe('http://storage:9000');
    });
  });

  describe('createDownloadUrl', () => {
    it('signs a GET with response headers and a bounded lifetime', async () => {
      const provider = makeProvider();

      const presigned = await provider.createDownloadUrl({
        key: 'users/u/documents/d/random',
        expiresInSeconds: 300,
        responseContentType: 'application/pdf',
        responseContentDisposition: 'attachment; filename="invoice.pdf"',
      });

      const url = new URL(presigned.url);
      expect(url.origin).toBe('http://localhost:9000');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.get('response-content-type')).toBe(
        'application/pdf',
      );
      expect(url.searchParams.get('response-content-disposition')).toBe(
        'attachment; filename="invoice.pdf"',
      );
      expect(presigned.method).toBe('GET');
    });
  });

  describe('headObject / objectExists / deleteObject', () => {
    it('maps NotFound to null / false and treats delete as idempotent', async () => {
      const provider = makeProvider();
      const notFound = Object.assign(new Error('nope'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });
      jest
        .spyOn(S3Client.prototype, 'send')
        .mockRejectedValue(notFound as never);

      await expect(provider.headObject('missing')).resolves.toBeNull();
      await expect(provider.objectExists('missing')).resolves.toBe(false);
      await expect(provider.deleteObject('missing')).resolves.toBeUndefined();
    });

    it('returns normalised metadata for an existing object', async () => {
      const provider = makeProvider();
      const lastModified = new Date('2026-10-09T00:00:00Z');
      jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({
        ContentLength: 42,
        ContentType: 'image/png',
        ETag: '"abc123"',
        LastModified: lastModified,
      } as never);

      await expect(provider.headObject('k')).resolves.toEqual({
        size: 42,
        contentType: 'image/png',
        etag: 'abc123',
        lastModified,
      });
    });

    it('wraps other provider errors in a generic StorageException', async () => {
      const provider = makeProvider();
      jest.spyOn(S3Client.prototype, 'send').mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:9000'), {
          name: 'TimeoutError',
        }) as never,
      );

      const error = await provider.headObject('k').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageException);
      expect((error as StorageException).code).toBe('STORAGE_ERROR');
      expect((error as StorageException).message).not.toContain('10.0.0.5');
      await expect(provider.isHealthy()).resolves.toBe(false);
    });
  });

  describe('onModuleInit', () => {
    it('creates a missing bucket when auto-create is enabled', async () => {
      const provider = makeProvider();
      const send = jest
        .spyOn(S3Client.prototype, 'send')
        .mockRejectedValueOnce(
          Object.assign(new Error('no bucket'), { name: 'NotFound' }) as never,
        )
        .mockResolvedValueOnce({} as never);

      await provider.onModuleInit();

      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][0].constructor.name).toBe(
        'CreateBucketCommand',
      );
    });

    it('fails fast on a missing bucket when auto-create is disabled', async () => {
      const storage: StorageConfig = {
        provider: 's3',
        s3: {
          endpoint: 'http://storage:9000',
          publicEndpoint: null,
          region: 'us-east-1',
          bucket: 'docuai-private',
          accessKey: 'k',
          secretKey: 'secret-value',
          forcePathStyle: true,
        },
        uploadUrlTtlSeconds: 900,
        downloadUrlTtlSeconds: 300,
        autoCreateBucket: false,
      };
      const provider = new S3StorageProvider({
        get: () => storage,
      } as unknown as ConfigService<AppConfig, true>);
      jest
        .spyOn(S3Client.prototype, 'send')
        .mockRejectedValue(
          Object.assign(new Error('no bucket'), { name: 'NotFound' }) as never,
        );

      await expect(provider.onModuleInit()).rejects.toThrow(
        /does not exist and S3_AUTO_CREATE_BUCKET is disabled/,
      );
    });
  });
});
