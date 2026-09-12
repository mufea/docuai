import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import {
  ApiResult,
  ResponseEnvelopeInterceptor,
} from './response-envelope.interceptor';

function createContext(requestId = 'req-42'): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ requestId }) }),
  } as unknown as ExecutionContext;
}

function handler<T>(value: T): CallHandler<T> {
  return { handle: () => of(value) };
}

describe('ResponseEnvelopeInterceptor', () => {
  const interceptor = new ResponseEnvelopeInterceptor();

  it('wraps plain payloads in the success envelope', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(createContext(), handler({ id: 1 })),
    );

    expect(result).toEqual({
      success: true,
      data: { id: 1 },
      message: null,
      requestId: 'req-42',
    });
  });

  it('unwraps ApiResult and keeps its message', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(
        createContext(),
        handler(new ApiResult({ ok: true }, 'Done')),
      ),
    );

    expect(result).toEqual({
      success: true,
      data: { ok: true },
      message: 'Done',
      requestId: 'req-42',
    });
  });

  it('normalises undefined payloads to null', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(createContext(), handler(undefined)),
    );

    expect(result.data).toBeNull();
  });
});
