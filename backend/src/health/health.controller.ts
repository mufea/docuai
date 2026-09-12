import { Controller, Get } from '@nestjs/common';
import { DependencyUnavailableException } from '../common/exceptions/dependency-unavailable.exception';
import { HealthService } from './health.service';
import type { HealthSnapshot } from './health.types';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async check(): Promise<HealthSnapshot> {
    const health = await this.healthService.check();

    if (health.status !== 'ok') {
      throw new DependencyUnavailableException(health);
    }

    return health;
  }
}
