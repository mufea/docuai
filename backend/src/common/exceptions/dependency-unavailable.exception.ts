import { HttpException, HttpStatus } from '@nestjs/common';
import type { HealthSnapshot } from '../../health/health.types';

export class DependencyUnavailableException extends HttpException {
  constructor(health: HealthSnapshot) {
    super(
      {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'One or more dependencies are unavailable',
        data: health,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
