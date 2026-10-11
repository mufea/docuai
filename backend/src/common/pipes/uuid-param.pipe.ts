import {
  ArgumentMetadata,
  HttpStatus,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import { ErrorCodes } from '../constants/error-codes';
import { AppException } from '../exceptions/app.exception';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates a UUID route parameter and reports failures with the standard
 * `VALIDATION_ERROR` code (Nest's `ParseUUIDPipe` would surface a generic
 * `BAD_REQUEST`). The value is lower-cased so lookups are canonical.
 */
@Injectable()
export class UuidParamPipe implements PipeTransform<string, string> {
  transform(value: string, metadata: ArgumentMetadata): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCodes.VALIDATION_ERROR,
        `${metadata.data ?? 'id'} must be a UUID`,
      );
    }
    return value.toLowerCase();
  }
}
