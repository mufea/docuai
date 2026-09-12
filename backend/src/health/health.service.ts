import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export interface HealthStatus {
  status: 'ok';
  service: string;
  database: 'up';
  redis: 'up';
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async check(): Promise<HealthStatus> {
    const [database, redis] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.redis.ping(),
    ]);
    const failures: string[] = [];
    if (database.status === 'rejected') failures.push('PostgreSQL');
    if (redis.status === 'rejected') failures.push('Redis');

    if (failures.length > 0) {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: `${failures.join(' and ')} unavailable`,
      });
    }

    return {
      status: 'ok',
      service: `${this.config.get<string>('appName', 'DocuAI')} API`,
      database: 'up',
      redis: 'up',
    };
  }
}
