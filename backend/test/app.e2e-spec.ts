import {
  BadRequestException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IsNotEmpty, IsString } from 'class-validator';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { ProbeModule } from './helpers/probe.module';

class SampleDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}

describe('Health, request ID, validation, and errors (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, ProbeModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/v1/health', () => {
    it('returns success with database and redis status', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: null,
        data: {
          status: 'ok',
          service: 'DocuAI API',
          database: 'up',
          redis: 'up',
        },
      });
      expect(typeof response.body.requestId).toBe('string');
      expect(response.body.requestId.length).toBeGreaterThan(0);
      expect(response.headers['x-request-id']).toBe(response.body.requestId);
    });
  });

  describe('X-Request-ID', () => {
    it('generates a request id when absent', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200);

      expect(response.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
    });

    it('preserves a client-supplied request id', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('X-Request-ID', 'test-123')
        .expect(200);

      expect(response.headers['x-request-id']).toBe('test-123');
      expect(response.body.requestId).toBe('test-123');
    });
  });

  describe('validation', () => {
    it('rejects invalid requests', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/probe/echo')
        .send({ name: '' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.data).toBeNull();
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(typeof response.body.message).toBe('string');
      expect(typeof response.body.requestId).toBe('string');
    });

    it('rejects unknown properties', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/probe/echo')
        .send({ name: 'ok', extra: true })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(String(response.body.message)).toMatch(/extra/i);
    });
  });

  describe('error handling', () => {
    it('returns the standard envelope for unexpected errors', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/probe/error')
        .set('X-Request-ID', 'error-123')
        .expect(500);

      expect(response.body).toMatchObject({
        success: false,
        data: null,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: 'error-123',
      });
      expect(response.body.stack).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toMatch(/boom/i);
      expect(response.headers['x-request-id']).toBe('error-123');
    });

    it('maps HTTP exceptions to the standard envelope', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/probe/not-found')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('NOT_FOUND');
      expect(typeof response.body.requestId).toBe('string');
    });
  });
});

describe('ValidationPipe', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  it('rejects unknown properties', async () => {
    await expect(
      pipe.transform(
        { name: 'ok', extra: true },
        { type: 'body', metatype: SampleDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid values', async () => {
    await expect(
      pipe.transform({ name: '' }, { type: 'body', metatype: SampleDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a valid payload', async () => {
    await expect(
      pipe.transform({ name: 'docuai' }, { type: 'body', metatype: SampleDto }),
    ).resolves.toEqual({ name: 'docuai' });
  });
});
