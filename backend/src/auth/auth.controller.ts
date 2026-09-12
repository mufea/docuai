import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiResult } from '../common/interceptors/response-envelope.interceptor';
import { UsersService } from '../users/users.service';
import { PublicUserDto, toPublicUser } from '../users/users.serializer';
import { sessionContextFromRequest } from './auth.context';
import { AuthService } from './auth.service';
import { AuthThrottle } from './decorators/auth-throttle.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { AuthResponseDto, TokenPairDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import type { AuthenticatedUser } from './interfaces/jwt-payload.interface';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Public()
  @AuthThrottle('register')
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an account and start a session' })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiConflictResponse({ description: 'AUTH_EMAIL_ALREADY_EXISTS' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
  ): Promise<AuthResponseDto> {
    return this.authService.register(
      dto,
      sessionContextFromRequest(req, dto.deviceName),
    );
  }

  @Public()
  @AuthThrottle('login')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate with email and password' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ description: 'AUTH_INVALID_CREDENTIALS' })
  @ApiForbiddenResponse({
    description: 'AUTH_ACCOUNT_SUSPENDED | AUTH_ACCOUNT_DELETED',
  })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<AuthResponseDto> {
    return this.authService.login(
      dto,
      sessionContextFromRequest(req, dto.deviceName),
    );
  }

  @Public()
  @AuthThrottle('refresh')
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair (always rotates)',
  })
  @ApiOkResponse({ type: TokenPairDto })
  @ApiUnauthorizedResponse({
    description:
      'AUTH_REFRESH_TOKEN_INVALID | AUTH_REFRESH_TOKEN_EXPIRED | AUTH_REFRESH_TOKEN_REUSED',
  })
  @ApiForbiddenResponse({
    description: 'AUTH_ACCOUNT_SUSPENDED | AUTH_ACCOUNT_DELETED',
  })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
  ): Promise<TokenPairDto> {
    return this.authService.refresh(
      dto.refreshToken,
      sessionContextFromRequest(req),
    );
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Revoke the presented refresh token (this device only)',
  })
  @ApiOkResponse({ description: 'Session revoked (idempotent)' })
  @ApiUnauthorizedResponse({
    description: 'AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN',
  })
  async logout(
    @Body() dto: LogoutDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<ApiResult<null>> {
    await this.authService.logout(
      dto.refreshToken,
      user.userId,
      sessionContextFromRequest(req),
    );
    return new ApiResult(null, 'Logged out');
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the authenticated user' })
  @ApiOkResponse({ type: PublicUserDto })
  @ApiUnauthorizedResponse({
    description: 'AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN',
  })
  @ApiForbiddenResponse({
    description: 'AUTH_ACCOUNT_SUSPENDED | AUTH_ACCOUNT_DELETED',
  })
  async me(@CurrentUser('userId') userId: string): Promise<PublicUserDto> {
    return toPublicUser(await this.usersService.getActiveUser(userId));
  }
}
