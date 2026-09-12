import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

export const TEST_PASSWORD = 'TestPassword123!';

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
}

export interface RegisteredUser {
  email: string;
  password: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
}

export async function registerUser(
  app: INestApplication,
  overrides: Partial<{ email: string; password: string; name: string }> = {},
): Promise<RegisteredUser> {
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? TEST_PASSWORD;

  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password, name: overrides.name ?? 'Test User' });

  if (res.status !== 201) {
    throw new Error(
      `registerUser failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  return {
    email,
    password,
    userId: res.body.data.user.id,
    accessToken: res.body.data.accessToken,
    refreshToken: res.body.data.refreshToken,
  };
}

export function login(app: INestApplication, email: string, password: string) {
  return request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password });
}

export function refresh(app: INestApplication, refreshToken: string) {
  return request(app.getHttpServer())
    .post('/api/v1/auth/refresh')
    .send({ refreshToken });
}

export function expectErrorEnvelope(
  body: unknown,
  code: string,
): asserts body is { code: string } {
  expect(body).toEqual({
    success: false,
    data: null,
    code,
    message: expect.any(String),
    requestId: expect.any(String),
  });
}
