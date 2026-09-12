import { Injectable, Logger } from '@nestjs/common';

export enum SecurityEventType {
  REGISTER_SUCCESS = 'REGISTER_SUCCESS',
  REGISTER_FAILED = 'REGISTER_FAILED',
  LOGIN_SUCCESS = 'LOGIN_SUCCESS',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGOUT = 'LOGOUT',
  REFRESH_TOKEN_ROTATED = 'REFRESH_TOKEN_ROTATED',
  REFRESH_TOKEN_REJECTED = 'REFRESH_TOKEN_REJECTED',
  REFRESH_TOKEN_REUSE_DETECTED = 'REFRESH_TOKEN_REUSE_DETECTED',
}

/**
 * Context attached to a security event. Deliberately narrow: no emails,
 * passwords, tokens or token hashes are accepted here so they cannot be
 * logged by accident.
 */
export interface SecurityEventContext {
  userId?: string | null;
  /** Session (refresh token row) id — never the token itself. */
  sessionId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  /** Short machine-readable reason, e.g. `invalid_password`, `suspended`. */
  reason?: string | null;
  /** Additional non-sensitive details, e.g. number of sessions revoked. */
  details?: Record<string, string | number | boolean | null>;
}

const EVENT_LEVEL: Record<SecurityEventType, 'log' | 'warn'> = {
  [SecurityEventType.REGISTER_SUCCESS]: 'log',
  [SecurityEventType.REGISTER_FAILED]: 'warn',
  [SecurityEventType.LOGIN_SUCCESS]: 'log',
  [SecurityEventType.LOGIN_FAILED]: 'warn',
  [SecurityEventType.LOGOUT]: 'log',
  [SecurityEventType.REFRESH_TOKEN_ROTATED]: 'log',
  [SecurityEventType.REFRESH_TOKEN_REJECTED]: 'warn',
  [SecurityEventType.REFRESH_TOKEN_REUSE_DETECTED]: 'warn',
};

/**
 * Central sink for authentication/authorization events. Phase 1 writes them
 * to the application logger as single-line structured records; later phases
 * can add persistence or alerting behind the same interface.
 */
@Injectable()
export class SecurityEventsService {
  private readonly logger = new Logger('SecurityEvent');

  record(type: SecurityEventType, context: SecurityEventContext = {}): void {
    const record: Record<string, unknown> = { event: type };

    if (context.userId) record.userId = context.userId;
    if (context.sessionId) record.sessionId = context.sessionId;
    if (context.requestId) record.requestId = context.requestId;
    if (context.ip) record.ip = context.ip;
    if (context.reason) record.reason = context.reason;
    if (context.details) Object.assign(record, context.details);

    const line = JSON.stringify(record);
    if (EVENT_LEVEL[type] === 'warn') {
      this.logger.warn(line);
    } else {
      this.logger.log(line);
    }
  }
}
