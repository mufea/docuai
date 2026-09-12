import { UserStatus } from '@prisma/client';
import request from 'supertest';
import { hashRefreshToken } from '../src/auth/utils/token.utils';
import {
  expectErrorEnvelope,
  login,
  refresh,
  registerUser,
} from './utils/auth-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

describe('POST /api/v1/auth/refresh (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.close();
  });

  const findByRaw = (raw: string) =>
    ctx.prisma.refreshToken.findUnique({
      where: {
        tokenHash: hashRefreshToken(raw, process.env.JWT_REFRESH_SECRET!),
      },
    });

  it('rotates: returns a new pair and revokes the presented token', async () => {
    const user = await registerUser(ctx.app);

    const res = await refresh(ctx.app, user.refreshToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        accessToken: expect.any(String),
        refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/),
        expiresIn: 900,
        tokenType: 'Bearer',
      },
      message: null,
      requestId: expect.any(String),
    });
    expect(res.body.data.refreshToken).not.toBe(user.refreshToken);

    const old = await findByRaw(user.refreshToken);
    const fresh = await findByRaw(res.body.data.refreshToken);
    expect(old?.revokedAt).toBeInstanceOf(Date);
    expect(fresh?.revokedAt).toBeNull();
    expect(fresh?.userId).toBe(user.userId);
  });

  it('the new access token is usable and the new refresh token can rotate again', async () => {
    const user = await registerUser(ctx.app);
    const first = await refresh(ctx.app, user.refreshToken);

    const me = await request(ctx.app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${first.body.data.accessToken}`);
    expect(me.status).toBe(200);

    const second = await refresh(ctx.app, first.body.data.refreshToken);
    expect(second.status).toBe(200);
  });

  it('the old refresh token becomes invalid after rotation', async () => {
    const user = await registerUser(ctx.app);
    await refresh(ctx.app, user.refreshToken);

    const res = await refresh(ctx.app, user.refreshToken);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_REFRESH_TOKEN_REUSED');
  });

  it('rejects an unknown refresh token', async () => {
    const res = await refresh(ctx.app, 'A'.repeat(64));

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_REFRESH_TOKEN_INVALID');
  });

  it('rejects a malformed refresh token without hitting the database', async () => {
    const res = await refresh(ctx.app, 'short');

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_REFRESH_TOKEN_INVALID');
  });

  it('rejects an expired refresh token and revokes it', async () => {
    const user = await registerUser(ctx.app);
    const record = await findByRaw(user.refreshToken);
    await ctx.prisma.refreshToken.update({
      where: { id: record!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await refresh(ctx.app, user.refreshToken);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_REFRESH_TOKEN_EXPIRED');
    const after = await findByRaw(user.refreshToken);
    expect(after?.revokedAt).toBeInstanceOf(Date);
  });

  it('rejects a revoked (logged-out) refresh token', async () => {
    const user = await registerUser(ctx.app);
    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ refreshToken: user.refreshToken });

    const res = await refresh(ctx.app, user.refreshToken);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_REFRESH_TOKEN_REUSED');
  });

  it('detects reuse and revokes every active session of the user', async () => {
    const user = await registerUser(ctx.app);
    // A second, independent device session that must be killed on reuse.
    const otherDevice = await login(ctx.app, user.email, user.password);
    expect(otherDevice.status).toBe(200);

    const rotated = await refresh(ctx.app, user.refreshToken);
    expect(rotated.status).toBe(200);

    ctx.logs.clear();
    const reuse = await refresh(ctx.app, user.refreshToken);
    expect(reuse.status).toBe(401);
    expectErrorEnvelope(reuse.body, 'AUTH_REFRESH_TOKEN_REUSED');
    expect(ctx.logs.text).toContain('REFRESH_TOKEN_REUSE_DETECTED');

    const active = await ctx.prisma.refreshToken.count({
      where: { userId: user.userId, revokedAt: null },
    });
    expect(active).toBe(0);

    const legit = await refresh(ctx.app, rotated.body.data.refreshToken);
    expect(legit.status).toBe(401);
    const other = await refresh(ctx.app, otherDevice.body.data.refreshToken);
    expect(other.status).toBe(401);
  });

  it('refuses to refresh for a suspended user and revokes the token', async () => {
    const user = await registerUser(ctx.app);
    await ctx.prisma.user.update({
      where: { id: user.userId },
      data: { status: UserStatus.SUSPENDED },
    });

    const res = await refresh(ctx.app, user.refreshToken);

    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, 'AUTH_ACCOUNT_SUSPENDED');
    const after = await findByRaw(user.refreshToken);
    expect(after?.revokedAt).toBeInstanceOf(Date);
  });

  it('refuses to refresh for a deleted user', async () => {
    const user = await registerUser(ctx.app);
    await ctx.prisma.user.update({
      where: { id: user.userId },
      data: { status: UserStatus.DELETED },
    });

    const res = await refresh(ctx.app, user.refreshToken);

    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, 'AUTH_ACCOUNT_DELETED');
  });

  it('lets exactly one of several concurrent refreshes with the same token succeed', async () => {
    const user = await registerUser(ctx.app);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => refresh(ctx.app, user.refreshToken)),
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 401)).toHaveLength(4);

    // Exactly one new token row was created for the winner.
    const created = await ctx.prisma.refreshToken.count({
      where: { userId: user.userId },
    });
    expect(created).toBe(2);
  });

  it('validates the body', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({});

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
  });
});
