import {
  ArgumentsHost,
  BadRequestException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { ErrorCodes } from '../constants/error-codes';
import { AppException } from '../exceptions/app.exception';
import { HttpExceptionFilter } from './http-exception.filter';

function createHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const request = {
    requestId: 'req-1',
    method: 'GET',
    originalUrl: '/api/v1/test',
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('maps AppException to its status and code', () => {
    const { host, status, json } = createHost();
    filter.catch(
      new AppException(
        HttpStatus.CONFLICT,
        'AUTH_EMAIL_ALREADY_EXISTS',
        'Email already in use',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      success: false,
      data: null,
      code: 'AUTH_EMAIL_ALREADY_EXISTS',
      message: 'Email already in use',
      requestId: 'req-1',
    });
  });

  it('maps validation errors to VALIDATION_ERROR with joined messages', () => {
    const { host, status, json } = createHost();
    filter.catch(
      new BadRequestException(['email must be an email', 'password too short']),
      host,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'email must be an email; password too short',
      }),
    );
  });

  it('maps standard HttpExceptions by status', () => {
    const { host, status, json } = createHost();
    filter.catch(new NotFoundException('Cannot GET /nope'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCodes.NOT_FOUND,
        message: 'Cannot GET /nope',
      }),
    );
  });

  it('maps throttler exceptions to RATE_LIMITED', () => {
    const { host, status, json } = createHost();
    filter.catch(new ThrottlerException(), host);

    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCodes.RATE_LIMITED }),
    );
  });

  it('hides details of unknown errors behind INTERNAL_ERROR', () => {
    const { host, status, json } = createHost();
    filter.catch(
      new Error('connection to database "secret-host" failed'),
      host,
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      data: null,
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Internal server error',
      requestId: 'req-1',
    });
  });
});
