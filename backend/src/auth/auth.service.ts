import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, RefreshToken, User, UserStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AppException } from '../common/exceptions/app.exception';
import { AppConfig, AuthConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../security/password.service';
import {
  SecurityEventType,
  SecurityEventsService,
} from '../security/security-events.service';
import {
  UsersService,
  isUniqueConstraintViolation,
} from '../users/users.service';
import { toPublicUser } from '../users/users.serializer';
import { AuthErrorCodes } from './auth.errors';
import { accountStatusException } from './auth.exceptions';
import { AuthResponseDto, TokenPairDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import {
  generateRefreshToken,
  hashRefreshToken,
  looksLikeRefreshToken,
} from './utils/token.utils';

/**
 * Per-request context. Everything here is optional and only used for
 * session metadata and security event correlation.
 */
export interface SessionContext {
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceName?: string | null;
}

interface IssuedRefreshToken {
  /** Raw token — returned to the client once, never stored or logged. */
  token: string;
  record: RefreshToken;
}

const USER_AGENT_MAX_LENGTH = 255;
const IP_MAX_LENGTH = 45;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly config: AuthConfig;

  /**
   * Hash verified against when the email is unknown, so login timing does not
   * reveal whether an account exists.
   */
  private decoyPasswordHash = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
    private readonly securityEvents: SecurityEventsService,
    configService: ConfigService<AppConfig, true>,
  ) {
    this.config = configService.get('auth', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    this.decoyPasswordHash = await this.passwordService.hash(
      randomBytes(32).toString('base64url'),
    );
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  async register(
    dto: RegisterDto,
    ctx: SessionContext = {},
  ): Promise<AuthResponseDto> {
    // Cheap pre-check so duplicates do not pay for an Argon2 hash. The unique
    // index remains the source of truth for concurrent registrations.
    if (await this.usersService.findByEmail(dto.email)) {
      this.rejectDuplicateEmail(ctx);
    }

    const passwordHash = await this.passwordService.hash(dto.password);

    let user: User;
    let issued: IssuedRefreshToken;
    try {
      ({ user, issued } = await this.prisma.$transaction(async (tx) => {
        const created = await this.usersService.create(
          { email: dto.email, passwordHash, name: dto.name ?? null },
          tx,
        );
        const token = await this.issueRefreshToken(tx, created.id, ctx);
        return { user: created, issued: token };
      }));
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        this.rejectDuplicateEmail(ctx);
      }
      throw error;
    }

    this.securityEvents.record(SecurityEventType.REGISTER_SUCCESS, {
      userId: user.id,
      sessionId: issued.record.id,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
    });

    return this.buildAuthResponse(user, issued.token);
  }

  private rejectDuplicateEmail(ctx: SessionContext): never {
    this.securityEvents.record(SecurityEventType.REGISTER_FAILED, {
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      reason: 'email_already_exists',
    });
    throw new AppException(
      HttpStatus.CONFLICT,
      AuthErrorCodes.AUTH_EMAIL_ALREADY_EXISTS,
      'An account with this email already exists',
    );
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  async login(
    dto: LoginDto,
    ctx: SessionContext = {},
  ): Promise<AuthResponseDto> {
    const user = await this.usersService.findByEmail(dto.email);

    const passwordMatches = await this.passwordService.verify(
      dto.password,
      user?.passwordHash ?? this.decoyPasswordHash,
    );

    if (!user || !passwordMatches) {
      this.securityEvents.record(SecurityEventType.LOGIN_FAILED, {
        userId: user?.id,
        requestId: ctx.requestId,
        ip: ctx.ipAddress,
        reason: user ? 'invalid_password' : 'unknown_email',
      });
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        AuthErrorCodes.AUTH_INVALID_CREDENTIALS,
        'Invalid email or password',
      );
    }

    // Status is only checked after the password matched, so an attacker
    // without the password learns nothing about the account.
    this.assertAccountActive(user, SecurityEventType.LOGIN_FAILED, ctx);

    const issued = await this.issueRefreshToken(this.prisma, user.id, ctx);

    this.securityEvents.record(SecurityEventType.LOGIN_SUCCESS, {
      userId: user.id,
      sessionId: issued.record.id,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
    });

    return this.buildAuthResponse(user, issued.token);
  }

  // ---------------------------------------------------------------------------
  // Refresh (rotation + reuse detection)
  // ---------------------------------------------------------------------------

  async refresh(
    rawToken: string,
    ctx: SessionContext = {},
  ): Promise<TokenPairDto> {
    const existing = await this.findRefreshToken(rawToken);

    if (!existing) {
      this.securityEvents.record(SecurityEventType.REFRESH_TOKEN_REJECTED, {
        requestId: ctx.requestId,
        ip: ctx.ipAddress,
        reason: 'unknown_token',
      });
      throw this.invalidRefreshToken();
    }

    if (existing.revokedAt) {
      throw await this.handleReuse(existing, ctx);
    }

    const now = new Date();
    if (existing.expiresAt <= now) {
      await this.prisma.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: now },
      });
      this.securityEvents.record(SecurityEventType.REFRESH_TOKEN_REJECTED, {
        userId: existing.userId,
        sessionId: existing.id,
        requestId: ctx.requestId,
        ip: ctx.ipAddress,
        reason: 'expired',
      });
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        AuthErrorCodes.AUTH_REFRESH_TOKEN_EXPIRED,
        'Refresh token has expired',
      );
    }

    if (existing.user.status !== UserStatus.ACTIVE) {
      await this.prisma.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: now },
      });
      this.assertAccountActive(
        existing.user,
        SecurityEventType.REFRESH_TOKEN_REJECTED,
        ctx,
      );
    }

    // Atomic rotation: the conditional update succeeds for exactly one of
    // any concurrent requests presenting the same token. PostgreSQL row
    // locking makes the loser re-evaluate `revokedAt IS NULL` after the
    // winner commits, so it sees count = 0.
    const rotated = await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count !== 1) return null;
      return this.issueRefreshToken(tx, existing.userId, {
        ...ctx,
        deviceName: ctx.deviceName ?? existing.deviceName,
      });
    });

    if (!rotated) {
      // Lost the race: the token was consumed by a concurrent request, which
      // is indistinguishable from replay. Treat it as reuse.
      throw await this.handleReuse(existing, ctx);
    }

    this.securityEvents.record(SecurityEventType.REFRESH_TOKEN_ROTATED, {
      userId: existing.userId,
      sessionId: rotated.record.id,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      details: { previousSessionId: existing.id },
    });

    return this.buildTokenPair(existing.userId, rotated.token);
  }

  /**
   * Security response to a revoked token being presented again: every active
   * session of the user is revoked, forcing re-authentication everywhere.
   * Returns the exception for the caller to throw.
   */
  private async handleReuse(
    token: RefreshToken,
    ctx: SessionContext,
  ): Promise<AppException> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId: token.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    this.securityEvents.record(SecurityEventType.REFRESH_TOKEN_REUSE_DETECTED, {
      userId: token.userId,
      sessionId: token.id,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      details: { revokedSessions: count },
    });

    return new AppException(
      HttpStatus.UNAUTHORIZED,
      AuthErrorCodes.AUTH_REFRESH_TOKEN_REUSED,
      'Refresh token is no longer valid',
    );
  }

  // ---------------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------------

  /**
   * Revokes the presented session only (other devices stay signed in).
   * Idempotent: unknown, already-revoked or foreign tokens all yield the same
   * successful response so the endpoint cannot be used as an oracle.
   */
  async logout(
    rawToken: string,
    userId: string,
    ctx: SessionContext = {},
  ): Promise<void> {
    const existing = await this.findRefreshToken(rawToken);

    if (!existing || existing.userId !== userId) {
      this.securityEvents.record(SecurityEventType.LOGOUT, {
        userId,
        requestId: ctx.requestId,
        ip: ctx.ipAddress,
        reason: existing ? 'token_belongs_to_other_user' : 'unknown_token',
      });
      return;
    }

    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    this.securityEvents.record(SecurityEventType.LOGOUT, {
      userId,
      sessionId: existing.id,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      reason: count === 1 ? 'revoked' : 'already_revoked',
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async findRefreshToken(
    rawToken: string,
  ): Promise<(RefreshToken & { user: User }) | null> {
    if (!looksLikeRefreshToken(rawToken)) return null;
    const tokenHash = hashRefreshToken(rawToken, this.config.refreshSecret);
    return this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
  }

  private async issueRefreshToken(
    tx: Prisma.TransactionClient,
    userId: string,
    ctx: SessionContext,
  ): Promise<IssuedRefreshToken> {
    const token = generateRefreshToken();
    const record = await tx.refreshToken.create({
      data: {
        userId,
        tokenHash: hashRefreshToken(token, this.config.refreshSecret),
        expiresAt: new Date(Date.now() + this.config.refreshTtlSeconds * 1000),
        deviceName: ctx.deviceName ?? null,
        userAgent: truncate(ctx.userAgent, USER_AGENT_MAX_LENGTH),
        ipAddress: truncate(ctx.ipAddress, IP_MAX_LENGTH),
      },
    });
    return { token, record };
  }

  private signAccessToken(userId: string): string {
    const payload: JwtPayload = { sub: userId };
    return this.jwtService.sign(payload);
  }

  private buildTokenPair(userId: string, refreshToken: string): TokenPairDto {
    return {
      accessToken: this.signAccessToken(userId),
      refreshToken,
      expiresIn: this.config.accessTtlSeconds,
      tokenType: 'Bearer',
    };
  }

  private buildAuthResponse(user: User, refreshToken: string): AuthResponseDto {
    return {
      ...this.buildTokenPair(user.id, refreshToken),
      user: toPublicUser(user),
    };
  }

  private invalidRefreshToken(): AppException {
    return new AppException(
      HttpStatus.UNAUTHORIZED,
      AuthErrorCodes.AUTH_REFRESH_TOKEN_INVALID,
      'Invalid refresh token',
    );
  }

  private assertAccountActive(
    user: User,
    failureEvent: SecurityEventType,
    ctx: SessionContext,
  ): void {
    if (user.status === UserStatus.ACTIVE) return;

    this.securityEvents.record(failureEvent, {
      userId: user.id,
      requestId: ctx.requestId,
      ip: ctx.ipAddress,
      reason: user.status === UserStatus.SUSPENDED ? 'suspended' : 'deleted',
    });
    throw accountStatusException(user.status);
  }
}

function truncate(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  if (!value) return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
