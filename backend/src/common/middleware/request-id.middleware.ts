import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Response } from 'express';
import { RequestWithId } from '../interfaces/request-with-id.interface';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: RequestWithId, response: Response, next: NextFunction): void {
    const suppliedId = request.header('X-Request-ID')?.trim();
    request.requestId = suppliedId || randomUUID();
    response.setHeader('X-Request-ID', request.requestId);
    next();
  }
}
