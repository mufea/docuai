import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception';

export const StorageErrorCodes = {
  STORAGE_ERROR: 'STORAGE_ERROR',
} as const;

/**
 * Raised when the storage backend cannot be reached or rejects a request.
 * The message is deliberately generic: provider error details (bucket names,
 * endpoints, request ids) go to the server log only.
 */
export class StorageException extends AppException {
  constructor(message = 'Object storage is currently unavailable') {
    super(
      HttpStatus.SERVICE_UNAVAILABLE,
      StorageErrorCodes.STORAGE_ERROR,
      message,
    );
  }
}
