import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter', () => {
  it('returns the standard error envelope with a request id', () => {
    const filter = new HttpExceptionFilter();
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });

    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({
          requestId: 'req-1',
          method: 'GET',
          originalUrl: '/api/v1/probe',
        }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(
      new HttpException('Resource missing', HttpStatus.NOT_FOUND),
      host,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      success: false,
      data: null,
      code: 'NOT_FOUND',
      message: 'Resource missing',
      requestId: 'req-1',
    });
  });

  it('hides unexpected error details from clients', () => {
    const filter = new HttpExceptionFilter();
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });

    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({
          requestId: 'req-2',
          method: 'GET',
          originalUrl: '/api/v1/probe',
        }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(new Error('secret stack'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      data: null,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: 'req-2',
    });
  });
});
