import { Request } from 'express';
import { getRequestId } from '../common/middleware/request-id.middleware';
import { SessionContext } from './auth.service';

/** Collects the request-derived session metadata passed to `AuthService`. */
export function sessionContextFromRequest(
  req: Request,
  deviceName?: string | null,
): SessionContext {
  return {
    requestId: getRequestId(req),
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    deviceName: deviceName ?? null,
  };
}
