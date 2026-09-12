import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

const INCOMING_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface RequestWithId extends Request {
  requestId: string;
}

/**
 * Assigns a request ID to every request. A well-formed incoming
 * `X-Request-Id` header is honoured so IDs can be correlated across proxies;
 * anything else is replaced with a fresh UUID. The ID is echoed back in the
 * response header and injected into every response envelope.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const requestId =
    incoming && INCOMING_REQUEST_ID_PATTERN.test(incoming)
      ? incoming
      : randomUUID();

  (req as RequestWithId).requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}

export function getRequestId(req: Request): string {
  return (req as RequestWithId).requestId ?? 'unknown';
}
