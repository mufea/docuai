import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { requestContext } from '../utils/request-context';

export interface ErrorEnvelope {
  success: false;
  data: unknown;
  code: string;
  message: string;
  requestId: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId =
      request.requestId ?? requestContext.getRequestId() ?? 'unknown';

    const { status, code, message, data } = this.normalize(exception);

    this.logger.error({
      msg: message,
      code,
      status,
      requestId,
      method: request.method,
      path: request.originalUrl ?? request.url,
    });

    const body: ErrorEnvelope = {
      success: false,
      data,
      code,
      message,
      requestId,
    };

    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    code: string;
    message: string;
    data: unknown;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'string') {
        return {
          status,
          code: statusToCode(status),
          message: payload,
          data: null,
        };
      }

      if (typeof payload === 'object' && payload !== null) {
        const record = payload as Record<string, unknown>;
        const rawMessage = record.message;
        const message = Array.isArray(rawMessage)
          ? rawMessage.map(String).join('; ')
          : typeof rawMessage === 'string'
            ? rawMessage
            : exception.message;

        return {
          status,
          code:
            typeof record.code === 'string'
              ? record.code
              : statusToCode(status),
          message: sanitizeClientMessage(message),
          data: record.data === undefined ? null : record.data,
        };
      }

      return {
        status,
        code: statusToCode(status),
        message: sanitizeClientMessage(exception.message),
        data: null,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      data: null,
    };
  }
}

function statusToCode(status: HttpStatus | number): string {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMIT_EXCEEDED';
    case 503:
      return 'DEPENDENCY_UNAVAILABLE';
    default:
      return 'INTERNAL_ERROR';
  }
}

function sanitizeClientMessage(message: string): string {
  const lowered = message.toLowerCase();
  const sensitive =
    lowered.includes('password') ||
    lowered.includes('secret') ||
    lowered.includes('jwt') ||
    lowered.includes('database_url') ||
    lowered.includes('redis_url') ||
    lowered.includes('postgresql://') ||
    lowered.includes('redis://');

  if (sensitive) {
    return 'An unexpected error occurred';
  }

  return message;
}
