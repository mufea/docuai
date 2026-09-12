import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { RequestWithId } from '../interfaces/request-with-id.interface';

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(request: RequestWithId, response: Response, next: NextFunction): void {
    const startedAt = Date.now();
    response.on('finish', () => {
      this.logger.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'info',
          requestId: request.requestId,
          method: request.method,
          path: request.originalUrl,
          status: response.statusCode,
          durationMs: Date.now() - startedAt,
        }),
      );
    });
    next();
  }
}
