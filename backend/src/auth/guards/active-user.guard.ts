import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AppException } from '../../common/exceptions/app.exception';
import { UsersService } from '../../users/users.service';
import { AuthErrorCodes } from '../auth.errors';
import { AuthenticatedUser } from '../interfaces/jwt-payload.interface';

/**
 * Runs after the global `JwtAuthGuard` and additionally requires the token's
 * subject to be an existing, ACTIVE account. Apply it to resource modules
 * (documents, folders) so a suspended or deleted user loses access to their
 * data immediately instead of after the access token expires.
 *
 * Needs `UsersModule` to be imported by the module that uses the guard.
 */
@Injectable()
export class ActiveUserGuard implements CanActivate {
  constructor(private readonly usersService: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser | undefined;
    if (!user?.userId) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        AuthErrorCodes.AUTH_UNAUTHORIZED,
        'Authentication required',
      );
    }
    await this.usersService.getActiveUser(user.userId);
    return true;
  }
}
