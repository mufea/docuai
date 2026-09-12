import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { RequestWithId } from '../interfaces/request-with-id.interface';

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  message: null;
  requestId: string;
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
    const request = context.switchToHttp().getRequest<RequestWithId>();
    return next.handle().pipe(
      map((data) => ({
        success: true,
        data,
        message: null,
        requestId: request.requestId,
      })),
    );
  }
}
