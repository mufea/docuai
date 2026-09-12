import { ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { AppException } from '../../common/exceptions/app.exception';
import { AuthErrorCodes } from '../auth.errors';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedUser } from '../interfaces/jwt-payload.interface';

/**
 * Registered globally (APP_GUARD): every route requires a valid access token
 * unless it is explicitly marked with `@Public()`. Failures are converted to
 * `AppException`s so they flow through the standard error envelope.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest<TUser = AuthenticatedUser>(
    err: unknown,
    user: TUser | false | null,
    info: unknown,
  ): TUser {
    if (err instanceof AppException) throw err;

    if (!user) {
      const reason = info instanceof Error ? info.message : '';
      if (reason === 'No auth token') {
        throw new AppException(
          HttpStatus.UNAUTHORIZED,
          AuthErrorCodes.AUTH_UNAUTHORIZED,
          'Authentication required',
        );
      }
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        AuthErrorCodes.AUTH_INVALID_TOKEN,
        'Invalid or expired access token',
      );
    }

    return user;
  }
}
