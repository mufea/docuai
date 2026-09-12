import request from 'supertest';
import { TestContext, createTestApp } from './utils/test-app';

describe('Phase 0 foundation (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('GET /api/v1/health', () => {
    it('reports database and redis as up inside the success envelope', async () => {
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: expect.objectContaining({
          status: 'ok',
          database: 'up',
          redis: 'up',
          uptime: expect.any(Number),
          timestamp: expect.any(String),
        }),
        message: null,
        requestId: expect.any(String),
      });
    });
  });

  describe('request ID', () => {
    it('generates a request ID and echoes it in the header and body', async () => {
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health');

      expect(res.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });

    it('honours a well-formed incoming X-Request-Id header', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/health')
        .set('X-Request-Id', 'client-trace-123');

      expect(res.headers['x-request-id']).toBe('client-trace-123');
      expect(res.body.requestId).toBe('client-trace-123');
    });

    it('replaces a malformed incoming X-Request-Id header', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/health')
        .set('X-Request-Id', 'bad id with spaces <script>');

      expect(res.headers['x-request-id']).not.toBe(
        'bad id with spaces <script>',
      );
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });
  });

  describe('error handling', () => {
    it('returns the error envelope for unknown routes', async () => {
      const res = await request(ctx.app.getHttpServer()).get(
        '/api/v1/does-not-exist',
      );

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        success: false,
        data: null,
        code: 'NOT_FOUND',
        message: expect.any(String),
        requestId: expect.any(String),
      });
    });
  });

  describe('security headers', () => {
    it('sets helmet security headers and hides x-powered-by', async () => {
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health');

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });
});
