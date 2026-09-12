import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IsString } from 'class-validator';
import { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from './app.module';
import { configureApplication } from './app.setup';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';

class ValidationFixture {
  @IsString()
  name!: string;
}

interface ResponseBody {
  success: boolean;
  data: unknown;
  message: string | null;
  code?: string;
  requestId: string;
}

describe('DocuAI Phase 0 integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApplication(app);
    await app.init();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
  });

  afterAll(async () => {
    await app.close();
  });

  const httpServer = (): Server => app.getHttpServer() as Server;

  it('returns dependency-aware health status in the success envelope', async () => {
    const response = await request(httpServer())
      .get('/api/v1/health')
      .expect(200);
    const body = response.body as ResponseBody;
    expect(body).toEqual({
      success: true,
      data: {
        status: 'ok',
        service: 'DocuAI API',
        database: 'up',
        redis: 'up',
      },
      message: null,
      requestId: body.requestId,
    });
    expect(body.requestId).toEqual(expect.any(String));
  });

  it('connects to PostgreSQL through Prisma', async () => {
    await expect(prisma.$queryRaw`SELECT 1`).resolves.toBeDefined();
  });

  it('connects to Redis', async () => {
    await expect(redis.ping()).resolves.toBe('PONG');
  });

  it('generates a UUID request ID and returns it in both locations', async () => {
    const response = await request(httpServer())
      .get('/api/v1/health')
      .expect(200);
    const body = response.body as ResponseBody;
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(body.requestId).toBe(response.headers['x-request-id']);
  });

  it('preserves a supplied request ID', async () => {
    const response = await request(httpServer())
      .get('/api/v1/health')
      .set('X-Request-ID', 'test-123')
      .expect(200);
    const body = response.body as ResponseBody;
    expect(response.headers['x-request-id']).toBe('test-123');
    expect(body.requestId).toBe('test-123');
  });

  it('rejects non-whitelisted input during validation', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    await expect(
      pipe.transform(
        { name: 'valid', unexpected: 'rejected' },
        { type: 'body', metatype: ValidationFixture },
      ),
    ).rejects.toThrow();
  });

  it('returns a safe error envelope for an unknown route', async () => {
    const response = await request(httpServer())
      .get('/api/v1/not-found')
      .set('X-Request-ID', 'error-test')
      .expect(404);
    const body = response.body as ResponseBody;
    expect(body).toEqual({
      success: false,
      data: null,
      code: 'HTTP_404',
      message: 'Cannot GET /api/v1/not-found',
      requestId: 'error-test',
    });
    expect(body).not.toHaveProperty('stack');
  });
});
