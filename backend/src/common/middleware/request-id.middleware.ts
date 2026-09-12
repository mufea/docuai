import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../utils/request-context';
import { resolveRequestId } from '../utils/request-id.util';

export const REQUEST_ID_HEADER = 'X-Request-ID';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = resolveRequestId(
      req.header(REQUEST_ID_HEADER),
      typeof req.id === 'string' ? req.id : undefined,
    );

    req.requestId = requestId;
    req.id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    requestContext.run({ requestId }, () => next());
  }
}
