import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, map } from 'rxjs';
import { requestContext } from '../utils/request-context';

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  message: null;
  requestId: string;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  SuccessEnvelope<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<SuccessEnvelope<T>> {
    const request = context.switchToHttp().getRequest<Request>();
    const requestId =
      request.requestId ?? requestContext.getRequestId() ?? 'unknown';

    return next.handle().pipe(
      map((data): SuccessEnvelope<T> => {
        if (isSuccessEnvelope(data)) {
          return data as SuccessEnvelope<T>;
        }

        return {
          success: true,
          data: (data ?? null) as T,
          message: null,
          requestId,
        };
      }),
    );
  }
}

function isSuccessEnvelope(value: unknown): value is SuccessEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return (
    'success' in value &&
    value.success === true &&
    'requestId' in value &&
    'data' in value
  );
}
