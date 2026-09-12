import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../constants/error-codes';

/**
 * Domain exception carrying a stable error code. The global exception filter
 * maps it onto the standard error envelope without further transformation.
 */
export class AppException extends HttpException {
  readonly code: ErrorCode;

  constructor(status: HttpStatus, code: ErrorCode, message: string) {
    super({ code, message }, status);
    this.code = code;
  }
}
