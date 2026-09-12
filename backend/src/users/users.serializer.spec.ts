import { User, UserStatus } from '@prisma/client';
import { toPublicUser } from './users.serializer';

describe('toPublicUser', () => {
  const user: User = {
    id: 'c0ffee00-0000-4000-8000-000000000001',
    email: 'user@example.com',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$salt$hash',
    name: 'Jane',
    avatarUrl: null,
    status: UserStatus.ACTIVE,
    emailVerified: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };

  it('maps exactly the public fields', () => {
    expect(toPublicUser(user)).toEqual({
      id: user.id,
      email: user.email,
      name: 'Jane',
      avatarUrl: null,
      status: 'ACTIVE',
      emailVerified: false,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
  });

  it('never exposes passwordHash, even when extra columns appear', () => {
    const withExtras = {
      ...user,
      passwordHash: 'should-not-leak',
      internalNote: 'also should not leak',
    } as User;

    const result = toPublicUser(withExtras);

    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('internalNote');
    expect(JSON.stringify(result)).not.toContain('should-not-leak');
  });
});
