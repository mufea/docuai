import { UserStatus } from '@prisma/client';
import request from 'supertest';
import {
  RegisteredUser,
  TEST_PASSWORD,
  expectErrorEnvelope,
  login,
  registerUser,
  uniqueEmail,
} from './utils/auth-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

describe('POST /api/v1/auth/login (e2e)', () => {
  let ctx: TestContext;
  let user: RegisteredUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await registerUser(ctx.app, { name: 'Login User' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('authenticates with valid credentials and creates a new session', async () => {
    const before = await ctx.prisma.refreshToken.count({
      where: { userId: user.userId },
    });

    const res = await login(ctx.app, user.email, user.password);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: 900,
      tokenType: 'Bearer',
      user: expect.objectContaining({
        id: user.userId,
        email: user.email,
        name: 'Login User',
        status: 'ACTIVE',
      }),
    });
    expect(res.body.data.refreshToken).not.toBe(user.refreshToken);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');

    const after = await ctx.prisma.refreshToken.count({
      where: { userId: user.userId },
    });
    expect(after).toBe(before + 1);
  });

  it('returns a generic error for a wrong password', async () => {
    const res = await login(ctx.app, user.email, 'definitely-wrong-password');

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_INVALID_CREDENTIALS');
    expect(res.body.message).toBe('Invalid email or password');
  });

  it('returns the same generic error for an unknown email', async () => {
    const res = await login(ctx.app, uniqueEmail('ghost'), TEST_PASSWORD);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_INVALID_CREDENTIALS');
    expect(res.body.message).toBe('Invalid email or password');
  });

  it('does not expose account status when the password is wrong', async () => {
    const suspended = await registerUser(ctx.app);
    await ctx.prisma.user.update({
      where: { id: suspended.userId },
      data: { status: UserStatus.SUSPENDED },
    });

    const res = await login(ctx.app, suspended.email, 'wrong-password-xyz');

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'AUTH_INVALID_CREDENTIALS');
  });

  it('refuses a suspended user with valid credentials', async () => {
    const suspended = await registerUser(ctx.app);
    await ctx.prisma.user.update({
      where: { id: suspended.userId },
      data: { status: UserStatus.SUSPENDED },
    });

    const res = await login(ctx.app, suspended.email, suspended.password);

    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, 'AUTH_ACCOUNT_SUSPENDED');
    expect(JSON.stringify(res.body)).not.toContain('accessToken');
  });

  it('refuses a deleted user with valid credentials', async () => {
    const deleted = await registerUser(ctx.app);
    await ctx.prisma.user.update({
      where: { id: deleted.userId },
      data: { status: UserStatus.DELETED },
    });

    const res = await login(ctx.app, deleted.email, deleted.password);

    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, 'AUTH_ACCOUNT_DELETED');
  });

  it('validates the body and rejects unknown fields', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password, remember: true });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
  });
});
