import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import {
  RegisteredUser,
  expectErrorEnvelope,
  registerUser,
} from './utils/auth-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

describe('JWT access tokens and JwtAuthGuard (e2e)', () => {
  let ctx: TestContext;
  let user: RegisteredUser;
  let jwtService: JwtService;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await registerUser(ctx.app);
    jwtService = ctx.app.get(JwtService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  const me = (authorization?: string) => {
    const req = request(ctx.app.getHttpServer()).get('/api/v1/auth/me');
    return authorization ? req.set('Authorization', authorization) : req;
  };

  it('accepts a valid access token', async () => {
    const res = await me(`Bearer ${user.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(user.userId);
  });

  it('carries only minimal claims in the token payload', () => {
    const payload = jwtService.decode<Record<string, unknown>>(
      user.accessToken,
    );

    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub']);
    expect(payload.sub).toBe(user.userId);
    expect((payload.exp as number) - (payload.iat as number)).toBe(900);
    expect(JSON.stringify(payload)).not.toContain(user.email);
  });

  it('rejects a missing token with 401 AUTH_UNAUTHORIZED', async () => {
    const res = await me();

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_UNAUTHORIZED');
  });

  it('rejects a malformed token', async () => {
    const res = await me('Bearer not.a.jwt');

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_INVALID_TOKEN');
  });

  it('rejects a non-bearer authorization scheme', async () => {
    const res = await me(`Basic ${Buffer.from('a:b').toString('base64')}`);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_UNAUTHORIZED');
  });

  it('rejects an expired token', async () => {
    const expired = jwtService.sign({ sub: user.userId }, { expiresIn: -60 });

    const res = await me(`Bearer ${expired}`);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_INVALID_TOKEN');
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = jwtService.sign(
      { sub: user.userId },
      { secret: 'another-secret-that-is-definitely-not-the-real-one' },
    );

    const res = await me(`Bearer ${forged}`);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_INVALID_TOKEN');
  });

  it('rejects an unsigned (alg=none) token', async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: user.userId,
        iat: 1,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url');

    const res = await me(`Bearer ${header}.${payload}.`);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_INVALID_TOKEN');
  });

  it('rejects a valid token whose subject is not a user id', async () => {
    const token = jwtService.sign({ sub: 'not-a-uuid' });

    const res = await me(`Bearer ${token}`);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_INVALID_TOKEN');
  });

  it('rejects a valid token for a user that no longer exists', async () => {
    const token = jwtService.sign({
      sub: '00000000-0000-4000-8000-000000000000',
    });

    const res = await me(`Bearer ${token}`);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_UNAUTHORIZED');
  });

  it('keeps public routes reachable without a token', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/health');

    expect(res.status).toBe(200);
  });
});
