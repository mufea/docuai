import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { DependencyStatus, HealthSnapshot } from './health.types';

const HEALTH_TIMEOUT_MS = 2500;

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async check(): Promise<HealthSnapshot> {
    const [database, redis] = await Promise.all([
      this.withTimeout(this.prisma.isHealthy()),
      this.withTimeout(this.redis.isHealthy()),
    ]);

    const allHealthy = database === 'up' && redis === 'up';

    return {
      status: allHealthy ? 'ok' : 'error',
      service: 'DocuAI API',
      database,
      redis,
    };
  }

  private async withTimeout(
    check: Promise<boolean>,
  ): Promise<DependencyStatus> {
    try {
      const result = await Promise.race([
        check,
        new Promise<boolean>((_, reject) => {
          setTimeout(
            () => reject(new Error('Health check timed out')),
            HEALTH_TIMEOUT_MS,
          );
        }),
      ]);

      return result ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
