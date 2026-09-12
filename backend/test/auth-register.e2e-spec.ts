import request from 'supertest';
import {
  TEST_PASSWORD,
  expectErrorEnvelope,
  login,
  uniqueEmail,
} from './utils/auth-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

describe('POST /api/v1/auth/register (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.close();
  });

  const post = (body: unknown) =>
    request(ctx.app.getHttpServer()).post('/api/v1/auth/register').send(body);

  it('registers a user and returns tokens plus the safe user representation', async () => {
    const email = uniqueEmail();
    const res = await post({
      email,
      password: TEST_PASSWORD,
      name: 'John Doe',
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      data: {
        accessToken: expect.stringMatching(/^[\w-]+\.[\w-]+\.[\w-]+$/),
        refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/),
        expiresIn: 900,
        tokenType: 'Bearer',
        user: {
          id: expect.any(String),
          email,
          name: 'John Doe',
          avatarUrl: null,
          status: 'ACTIVE',
          emailVerified: false,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      },
      message: null,
      requestId: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain(TEST_PASSWORD);
  });

  it('persists only an Argon2id hash of the password and one refresh token hash', async () => {
    const email = uniqueEmail();
    const res = await post({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(201);

    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { email },
      include: { refreshTokens: true },
    });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(TEST_PASSWORD);
    expect(user.refreshTokens).toHaveLength(1);
    expect(user.refreshTokens[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(user.refreshTokens[0].tokenHash).not.toBe(
      res.body.data.refreshToken,
    );
    expect(user.refreshTokens[0].revokedAt).toBeNull();
    expect(user.refreshTokens[0].expiresAt.getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('normalises the email before persisting and allows login with any casing', async () => {
    const local = uniqueEmail('Mixed').split('@')[0];
    const messy = `  ${local.toUpperCase()}@EXAMPLE.COM  `;
    const normalised = `${local.toLowerCase()}@example.com`;

    const res = await post({ email: messy, password: TEST_PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe(normalised);
    await expect(
      ctx.prisma.user.findUnique({ where: { email: normalised } }),
    ).resolves.not.toBeNull();

    const loginRes = await login(
      ctx.app,
      `${local}@Example.Com`,
      TEST_PASSWORD,
    );
    expect(loginRes.status).toBe(200);
  });

  it('rejects a duplicate email with 409 regardless of casing', async () => {
    const email = uniqueEmail();
    await post({ email, password: TEST_PASSWORD });

    const res = await post({
      email: email.toUpperCase(),
      password: 'AnotherPass1!',
    });

    expect(res.status).toBe(409);
    expectErrorEnvelope(res.body, 'AUTH_EMAIL_ALREADY_EXISTS');
  });

  it('rejects an invalid email', async () => {
    const res = await post({ email: 'not-an-email', password: TEST_PASSWORD });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    expect(res.body.message).toContain('email');
  });

  it('rejects a short password', async () => {
    const res = await post({ email: uniqueEmail(), password: 'short1' });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    expect(res.body.message).toContain('password');
  });

  it('rejects an excessively long password', async () => {
    const res = await post({ email: uniqueEmail(), password: 'x'.repeat(129) });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
  });

  it('rejects missing required fields', async () => {
    const res = await post({ name: 'Nobody' });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    expect(res.body.message).toContain('email');
    expect(res.body.message).toContain('password');
  });

  it('rejects non-string passwords', async () => {
    const res = await post({ email: uniqueEmail(), password: 12345678 });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
  });

  it('rejects unknown fields', async () => {
    const res = await post({
      email: uniqueEmail(),
      password: TEST_PASSWORD,
      status: 'ADMIN',
      emailVerified: true,
    });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    expect(res.body.message).toContain('status should not exist');
    expect(res.body.message).toContain('emailVerified should not exist');
  });

  it('treats the password as opaque and never trims it', async () => {
    const email = uniqueEmail();
    const padded = '  padded password  ';

    const res = await post({ email, password: padded });
    expect(res.status).toBe(201);

    const trimmed = await login(ctx.app, email, padded.trim());
    expect(trimmed.status).toBe(401);

    const exact = await login(ctx.app, email, padded);
    expect(exact.status).toBe(200);
  });

  it('rejects an empty JSON body', async () => {
    const res = await post({});

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
  });
});
