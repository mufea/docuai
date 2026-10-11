import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import { getRequestId } from '../middleware/request-id.middleware';

/** Request-derived correlation data attached to security/audit events. */
export interface RequestContext {
  requestId: string | null;
  ipAddress: string | null;
}

export function requestContextFromRequest(req: Request): RequestContext {
  return {
    requestId: getRequestId(req),
    ipAddress: req.ip ?? null,
  };
}

/**
 *   @Post() create(@RequestCtx() ctx: RequestContext) { ... }
 */
export const RequestCtx = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestContext =>
    requestContextFromRequest(ctx.switchToHttp().getRequest<Request>()),
);
