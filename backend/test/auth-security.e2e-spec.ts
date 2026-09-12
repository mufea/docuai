import request from 'supertest';
import {
  TEST_PASSWORD,
  expectErrorEnvelope,
  login,
  refresh,
  registerUser,
  uniqueEmail,
} from './utils/auth-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

describe('Authentication security (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('rate limiting', () => {
    const original: Record<string, string | undefined> = {};

    beforeEach(async () => {
      for (const key of [
        'AUTH_LOGIN_RATE_LIMIT',
        'AUTH_REGISTER_RATE_LIMIT',
        'AUTH_REFRESH_RATE_LIMIT',
      ]) {
        original[key] = process.env[key];
      }
      await ctx.redis.getClient().flushdb();
    });

    afterEach(async () => {
      for (const [key, value] of Object.entries(original)) {
        process.env[key] = value;
      }
      await ctx.redis.getClient().flushdb();
    });

    it('throttles login after AUTH_LOGIN_RATE_LIMIT attempts per window', async () => {
      process.env.AUTH_LOGIN_RATE_LIMIT = '3';
      const email = uniqueEmail('limited');

      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await login(ctx.app, email, 'wrong-password');
        statuses.push(res.status);
      }

      expect(statuses).toEqual([401, 401, 401, 429, 429]);

      const last = await login(ctx.app, email, 'wrong-password');
      expectErrorEnvelope(last.body, 'RATE_LIMITED');
      expect(last.headers['retry-after']).toBeDefined();
    });

    it('throttles registration independently of login', async () => {
      process.env.AUTH_REGISTER_RATE_LIMIT = '2';

      const first = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail(), password: TEST_PASSWORD });
      const second = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail(), password: TEST_PASSWORD });
      const third = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail(), password: TEST_PASSWORD });

      expect([first.status, second.status, third.status]).toEqual([
        201, 201, 429,
      ]);

      // Login bucket is separate and still open.
      const loginRes = await login(
        ctx.app,
        first.body.data.user.email,
        TEST_PASSWORD,
      );
      expect(loginRes.status).toBe(200);
    });

    it('throttles refresh', async () => {
      process.env.AUTH_REFRESH_RATE_LIMIT = '2';

      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await refresh(ctx.app, 'B'.repeat(64));
        statuses.push(res.status);
      }

      expect(statuses).toEqual([401, 401, 429]);
    });

    it('excludes the health endpoint from throttling', async () => {
      process.env.AUTH_LOGIN_RATE_LIMIT = '1';
      await login(ctx.app, uniqueEmail(), 'wrong-password');
      await login(ctx.app, uniqueEmail(), 'wrong-password');

      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health');
      expect(res.status).toBe(200);
    });
  });

  describe('logging hygiene', () => {
    it('never writes passwords, tokens or token hashes to the application log', async () => {
      ctx.logs.clear();
      const password = 'Sup3r-Secret-Passw0rd!';
      const user = await registerUser(ctx.app, { password });

      await login(ctx.app, user.email, password);
      await login(ctx.app, user.email, 'wrong-password-attempt');
      const rotated = await refresh(ctx.app, user.refreshToken);
      await refresh(ctx.app, user.refreshToken); // reuse → security event
      await request(ctx.app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${user.accessToken}`);
      await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ refreshToken: rotated.body.data.refreshToken });

      const text = ctx.logs.text;
      expect(text).toContain('REGISTER_SUCCESS');
      expect(text).toContain('LOGIN_SUCCESS');
      expect(text).toContain('LOGIN_FAILED');
      expect(text).toContain('REFRESH_TOKEN_ROTATED');
      expect(text).toContain('REFRESH_TOKEN_REUSE_DETECTED');
      expect(text).toContain('LOGOUT');

      expect(text).not.toContain(password);
      expect(text).not.toContain('wrong-password-attempt');
      expect(text).not.toContain(user.accessToken);
      expect(text).not.toContain(user.refreshToken);
      expect(text).not.toContain(rotated.body.data.refreshToken);
      expect(text).not.toContain(rotated.body.data.accessToken);
      expect(text).not.toContain(user.email);
      expect(text).not.toMatch(/\$argon2/);

      const hashes = await ctx.prisma.refreshToken.findMany({
        where: { userId: user.userId },
        select: { tokenHash: true },
      });
      for (const { tokenHash } of hashes) {
        expect(text).not.toContain(tokenHash);
      }
      expect(text).not.toContain(process.env.JWT_ACCESS_SECRET!);
      expect(text).not.toContain(process.env.JWT_REFRESH_SECRET!);
    });

    it('does not leak internal errors to clients', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"email": "broken json');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.requestId).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js/);
    });
  });
});
