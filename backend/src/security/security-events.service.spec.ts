import { Logger } from '@nestjs/common';
import {
  SecurityEventType,
  SecurityEventsService,
} from './security-events.service';

describe('SecurityEventsService', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  const service = new SecurityEventsService();

  beforeEach(() => {
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes successful events at log level as structured JSON', () => {
    service.record(SecurityEventType.LOGIN_SUCCESS, {
      userId: 'u1',
      sessionId: 's1',
      requestId: 'r1',
      ip: '10.0.0.1',
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
      event: 'LOGIN_SUCCESS',
      userId: 'u1',
      sessionId: 's1',
      requestId: 'r1',
      ip: '10.0.0.1',
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('writes failures and reuse detection at warn level with reason/details', () => {
    service.record(SecurityEventType.REFRESH_TOKEN_REUSE_DETECTED, {
      userId: 'u1',
      reason: 'revoked_token_presented',
      details: { revokedSessions: 3 },
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warnSpy.mock.calls[0][0] as string)).toEqual({
      event: 'REFRESH_TOKEN_REUSE_DETECTED',
      userId: 'u1',
      reason: 'revoked_token_presented',
      revokedSessions: 3,
    });
  });

  it('omits empty context fields', () => {
    service.record(SecurityEventType.LOGOUT, { userId: null, ip: undefined });

    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
      event: 'LOGOUT',
    });
  });
});
