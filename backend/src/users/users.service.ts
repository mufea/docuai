import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, User, UserStatus } from '@prisma/client';
import { AuthErrorCodes } from '../auth/auth.errors';
import { accountStatusException } from '../auth/auth.exceptions';
import { AppException } from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersErrorCodes } from './users.errors';

export interface CreateUserInput {
  /** Already normalised email (see `normalizeEmail`). */
  email: string;
  passwordHash: string;
  name?: string | null;
}

/**
 * Canonical email form used for uniqueness and lookups.
 * Lower-casing the whole address is a deliberate product decision: mailbox
 * providers relevant to DocuAI treat local parts case-insensitively.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
    });
  }

  /**
   * Loads the principal behind a validated access token. Because the JWT is
   * not checked against the database on every request, this is where a
   * suspended or deleted account is cut off from account-level endpoints.
   */
  async getActiveUser(userId: string): Promise<User> {
    const user = await this.findById(userId);
    if (!user) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        AuthErrorCodes.AUTH_UNAUTHORIZED,
        'Authentication required',
      );
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw accountStatusException(user.status);
    }
    return user;
  }

  /**
   * Creates a user. Relies on the unique index rather than a prior lookup so
   * two concurrent registrations for the same email cannot both succeed.
   */
  create(
    input: CreateUserInput,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<User> {
    return tx.user.create({
      data: {
        email: normalizeEmail(input.email),
        passwordHash: input.passwordHash,
        name: input.name ?? null,
      },
    });
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<User> {
    const data: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.avatarUrl !== undefined) data.avatarUrl = dto.avatarUrl;

    try {
      return await this.prisma.user.update({ where: { id: userId }, data });
    } catch (error) {
      if (isRecordNotFound(error)) {
        throw new AppException(
          HttpStatus.NOT_FOUND,
          UsersErrorCodes.USER_NOT_FOUND,
          'User not found',
        );
      }
      throw error;
    }
  }
}

export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

export function isRecordNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2025'
  );
}
