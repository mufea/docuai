import { HttpStatus } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { AppException } from '../common/exceptions/app.exception';
import { AuthErrorCodes } from './auth.errors';

/** Exception for a non-ACTIVE account, shared by login, refresh and /me. */
export function accountStatusException(status: UserStatus): AppException {
  if (status === UserStatus.SUSPENDED) {
    return new AppException(
      HttpStatus.FORBIDDEN,
      AuthErrorCodes.AUTH_ACCOUNT_SUSPENDED,
      'This account has been suspended',
    );
  }
  return new AppException(
    HttpStatus.FORBIDDEN,
    AuthErrorCodes.AUTH_ACCOUNT_DELETED,
    'This account is no longer available',
  );
}
