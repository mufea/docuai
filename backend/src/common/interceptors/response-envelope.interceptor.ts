import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, map } from 'rxjs';
import { getRequestId } from '../middleware/request-id.middleware';

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  message: string | null;
  requestId: string;
}

/**
 * Handlers may return this wrapper to attach a human-readable message to a
 * successful response. Plain return values are wrapped with `message: null`.
 */
export class ApiResult<T> {
  constructor(
    readonly data: T,
    readonly message: string | null = null,
  ) {}
}

@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<
  T,
  SuccessEnvelope<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<SuccessEnvelope<T>> {
    const request = context.switchToHttp().getRequest<Request>();
    const requestId = getRequestId(request);

    return next.handle().pipe(
      map((payload) => {
        if (payload instanceof ApiResult) {
          return {
            success: true as const,
            data: payload.data as T,
            message: payload.message,
            requestId,
          };
        }
        return {
          success: true as const,
          data: payload === undefined ? (null as T) : payload,
          message: null,
          requestId,
        };
      }),
    );
  }
}
