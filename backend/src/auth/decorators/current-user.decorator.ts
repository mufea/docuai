import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../interfaces/jwt-payload.interface';

/**
 * Injects the authenticated principal set by `JwtStrategy`.
 *
 *   @Get('me') me(@CurrentUser() user: AuthenticatedUser) { ... }
 *   @Get('me') me(@CurrentUser('userId') userId: string) { ... }
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser | undefined;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);
