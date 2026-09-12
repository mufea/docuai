import { UserStatus } from '@prisma/client';
import request from 'supertest';
import {
  RegisteredUser,
  expectErrorEnvelope,
  registerUser,
} from './utils/auth-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

describe('Users endpoints (e2e)', () => {
  let ctx: TestContext;
  let user: RegisteredUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await registerUser(ctx.app, { name: 'Original Name' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  const server = () => ctx.app.getHttpServer();
  const auth = (token = user.accessToken) => `Bearer ${token}`;

  describe('GET /api/v1/users/me and GET /api/v1/auth/me', () => {
    it('returns the safe user representation when authenticated', async () => {
      const res = await request(server())
        .get('/api/v1/users/me')
        .set('Authorization', auth());

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        id: user.userId,
        email: user.email,
        name: 'Original Name',
        avatarUrl: null,
        status: 'ACTIVE',
        emailVerified: false,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(res.body.data).not.toHaveProperty('passwordHash');
    });

    it('returns the same representation from /auth/me', async () => {
      const [usersMe, authMe] = await Promise.all([
        request(server()).get('/api/v1/users/me').set('Authorization', auth()),
        request(server()).get('/api/v1/auth/me').set('Authorization', auth()),
      ]);

      expect(authMe.status).toBe(200);
      expect(authMe.body.data).toEqual(usersMe.body.data);
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(server()).get('/api/v1/users/me');

      expect(res.status).toBe(401);
      expectErrorEnvelope(res.body, 'AUTH_UNAUTHORIZED');
    });
  });

  describe('PATCH /api/v1/users/me', () => {
    it('updates name and avatarUrl', async () => {
      const res = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', auth())
        .send({
          name: '  Updated User  ',
          avatarUrl: 'https://cdn.example.com/a.png',
        });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: user.userId,
        name: 'Updated User',
        avatarUrl: 'https://cdn.example.com/a.png',
      });

      const stored = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: user.userId },
      });
      expect(stored.name).toBe('Updated User');
      expect(stored.avatarUrl).toBe('https://cdn.example.com/a.png');
    });

    it('supports partial updates and clearing a field with null', async () => {
      const res = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', auth())
        .send({ avatarUrl: null });

      expect(res.status).toBe(200);
      expect(res.body.data.avatarUrl).toBeNull();
      expect(res.body.data.name).toBe('Updated User');
    });

    it.each([
      ['email', 'new@example.com'],
      ['status', 'SUSPENDED'],
      ['emailVerified', true],
      ['passwordHash', '$argon2id$fake'],
      ['id', '00000000-0000-4000-8000-000000000000'],
      ['createdAt', '2000-01-01T00:00:00.000Z'],
      ['updatedAt', '2000-01-01T00:00:00.000Z'],
    ])('rejects the forbidden field %s', async (field, value) => {
      const res = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', auth())
        .send({ name: 'Still Fine', [field]: value });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
      expect(res.body.message).toContain(`property ${field} should not exist`);

      const stored = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: user.userId },
      });
      expect(stored.email).toBe(user.email);
      expect(stored.status).toBe(UserStatus.ACTIVE);
      expect(stored.emailVerified).toBe(false);
      expect(stored.name).toBe('Updated User');
    });

    it('rejects an invalid avatar URL', async () => {
      const res = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', auth())
        .send({ avatarUrl: 'javascript:alert(1)' });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('rejects an empty name', async () => {
      const res = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', auth())
        .send({ name: '   ' });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(server())
        .patch('/api/v1/users/me')
        .send({ name: 'Anonymous' });

      expect(res.status).toBe(401);
      expectErrorEnvelope(res.body, 'AUTH_UNAUTHORIZED');
    });

    it('refuses a suspended user even with a still-valid access token', async () => {
      const suspended = await registerUser(ctx.app);
      await ctx.prisma.user.update({
        where: { id: suspended.userId },
        data: { status: UserStatus.SUSPENDED },
      });

      const res = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', auth(suspended.accessToken))
        .send({ name: 'Sneaky' });

      expect(res.status).toBe(403);
      expectErrorEnvelope(res.body, 'AUTH_ACCOUNT_SUSPENDED');
    });
  });

  it('never includes passwordHash in any user-bearing response', async () => {
    const responses = await Promise.all([
      request(server()).get('/api/v1/users/me').set('Authorization', auth()),
      request(server()).get('/api/v1/auth/me').set('Authorization', auth()),
      request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', auth())
        .send({ name: 'Final Name' }),
      request(server())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password }),
    ]);

    for (const res of responses) {
      expect(res.status).toBeLessThan(300);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('passwordHash');
      expect(text).not.toContain('password_hash');
      expect(text).not.toContain('$argon2');
    }
  });
});
