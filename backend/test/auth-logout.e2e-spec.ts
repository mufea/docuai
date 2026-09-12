import request from 'supertest';
import {
  expectErrorEnvelope,
  login,
  refresh,
  registerUser,
} from './utils/auth-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

describe('POST /api/v1/auth/logout (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.close();
  });

  const logout = (accessToken: string | undefined, refreshToken: string) => {
    const req = request(ctx.app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken });
    return accessToken
      ? req.set('Authorization', `Bearer ${accessToken}`)
      : req;
  };

  it('revokes the presented session and returns a message', async () => {
    const user = await registerUser(ctx.app);

    const res = await logout(user.accessToken, user.refreshToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: null,
      message: 'Logged out',
      requestId: expect.any(String),
    });

    const active = await ctx.prisma.refreshToken.count({
      where: { userId: user.userId, revokedAt: null },
    });
    expect(active).toBe(0);
  });

  it('prevents the revoked refresh token from being used again', async () => {
    const user = await registerUser(ctx.app);
    await logout(user.accessToken, user.refreshToken);

    const res = await refresh(ctx.app, user.refreshToken);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_REFRESH_TOKEN_REUSED');
  });

  it('is idempotent: logging out twice succeeds both times', async () => {
    const user = await registerUser(ctx.app);

    const first = await logout(user.accessToken, user.refreshToken);
    const second = await logout(user.accessToken, user.refreshToken);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('succeeds silently for an unknown refresh token', async () => {
    const user = await registerUser(ctx.app);

    const res = await logout(user.accessToken, 'Z'.repeat(64));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('only revokes the presented device session, not other sessions', async () => {
    const user = await registerUser(ctx.app);
    const tablet = await login(ctx.app, user.email, user.password);
    expect(tablet.status).toBe(200);

    await logout(user.accessToken, user.refreshToken);

    const stillValid = await refresh(ctx.app, tablet.body.data.refreshToken);
    expect(stillValid.status).toBe(200);
  });

  it("does not revoke another user's session", async () => {
    const alice = await registerUser(ctx.app);
    const bob = await registerUser(ctx.app);

    const res = await logout(alice.accessToken, bob.refreshToken);
    expect(res.status).toBe(200);

    const bobStillValid = await refresh(ctx.app, bob.refreshToken);
    expect(bobStillValid.status).toBe(200);
  });

  it('requires authentication', async () => {
    const user = await registerUser(ctx.app);

    const res = await logout(undefined, user.refreshToken);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_UNAUTHORIZED');
  });
});
