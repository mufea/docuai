import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorCode, ErrorCodes } from '../constants/error-codes';
import { AppException } from '../exceptions/app.exception';
import { getRequestId } from '../middleware/request-id.middleware';

export interface ErrorEnvelope {
  success: false;
  data: null;
  code: ErrorCode;
  message: string;
  requestId: string;
}

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  [HttpStatus.BAD_REQUEST]: ErrorCodes.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ErrorCodes.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCodes.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCodes.NOT_FOUND,
  [HttpStatus.METHOD_NOT_ALLOWED]: ErrorCodes.METHOD_NOT_ALLOWED,
  [HttpStatus.CONFLICT]: ErrorCodes.CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCodes.PAYLOAD_TOO_LARGE,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: ErrorCodes.UNSUPPORTED_MEDIA_TYPE,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCodes.RATE_LIMITED,
  [HttpStatus.INTERNAL_SERVER_ERROR]: ErrorCodes.INTERNAL_ERROR,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCodes.SERVICE_UNAVAILABLE,
};

interface NestErrorBody {
  statusCode?: number;
  message?: string | string[];
  error?: string;
  code?: string;
}

/**
 * Translates every thrown error into the standard error envelope. Unknown
 * errors (including database driver errors) are logged with their stack and
 * request ID but never leak details to the client.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = getRequestId(request);

    const { status, code, message } = this.resolve(
      exception,
      requestId,
      request,
    );

    const body: ErrorEnvelope = {
      success: false,
      data: null,
      code,
      message,
      requestId,
    };

    response.status(status).json(body);
  }

  private resolve(
    exception: unknown,
    requestId: string,
    request: Request,
  ): { status: number; code: ErrorCode; message: string } {
    if (exception instanceof AppException) {
      const body = exception.getResponse() as NestErrorBody;
      return {
        status: exception.getStatus(),
        code: exception.code,
        message:
          typeof body?.message === 'string' ? body.message : exception.message,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      return {
        status,
        code: this.codeForHttpException(status, body),
        message: this.messageForHttpException(status, body),
      };
    }

    const error =
      exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(
      `Unhandled exception on ${request.method} ${request.originalUrl} [requestId=${requestId}]: ${error.message}`,
      error.stack,
    );

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Internal server error',
    };
  }

  private codeForHttpException(status: HttpStatus, body: unknown): ErrorCode {
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      return ErrorCodes.RATE_LIMITED;
    }
    if (status === HttpStatus.BAD_REQUEST && this.isValidationBody(body)) {
      return ErrorCodes.VALIDATION_ERROR;
    }
    if (typeof body === 'object' && body !== null) {
      const code = (body as NestErrorBody).code;
      if (typeof code === 'string' && code.length > 0) return code;
    }
    return STATUS_TO_CODE[status] ?? ErrorCodes.INTERNAL_ERROR;
  }

  private messageForHttpException(status: HttpStatus, body: unknown): string {
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      return 'Too many requests, please try again later';
    }
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      return 'Internal server error';
    }
    if (typeof body === 'string') return body;
    if (typeof body === 'object' && body !== null) {
      const { message } = body as NestErrorBody;
      if (Array.isArray(message)) return message.join('; ');
      if (typeof message === 'string') return message;
    }
    return 'Request failed';
  }

  private isValidationBody(body: unknown): boolean {
    return (
      typeof body === 'object' &&
      body !== null &&
      Array.isArray((body as NestErrorBody).message)
    );
  }
}
