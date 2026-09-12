import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { RequestWithId } from '../interfaces/request-with-id.interface';

interface ErrorResponse {
  code?: string;
  message?: string | string[];
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithId>();
    const response = http.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const details: ErrorResponse =
      typeof exceptionResponse === 'object' && exceptionResponse !== null
        ? (exceptionResponse as ErrorResponse)
        : {};
    const rawMessage =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : details.message;
    const message = Array.isArray(rawMessage)
      ? rawMessage.join('; ')
      : (rawMessage ?? 'An unexpected error occurred');
    const isInternalError = status === 500;
    const code =
      details.code ??
      (isInternalError ? 'INTERNAL_SERVER_ERROR' : `HTTP_${status}`);

    if (status >= 500) {
      this.logger.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          requestId: request.requestId,
          method: request.method,
          path: request.originalUrl,
          status,
          code,
        }),
      );
    }

    response.status(status).json({
      success: false,
      data: null,
      code,
      message: isInternalError ? 'An unexpected error occurred' : message,
      requestId: request.requestId,
    });
  }
}
