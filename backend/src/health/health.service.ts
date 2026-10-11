import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { StorageProvider } from '../storage/storage.provider';
import { OcrHealthService, OcrHealthStatus } from '../ocr/ocr-health.service';

export type DependencyStatus = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'degraded';
  database: DependencyStatus;
  redis: DependencyStatus;
  storage: DependencyStatus;
  /**
   * OCR readiness summary (Phase 3). Informational: it does not affect
   * `status`, see GET /health/ocr for details.
   */
  ocr: OcrHealthStatus;
  uptime: number;
  timestamp: string;
}

export const HEALTH_DEPENDENCIES = ['database', 'redis', 'storage'] as const;

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageProvider,
    private readonly ocrHealth: OcrHealthService,
  ) {}

  async check(): Promise<HealthReport> {
    const [database, redis, storage, ocr] = await Promise.all([
      this.prisma.isHealthy(),
      this.redis.isHealthy(),
      this.storage.isHealthy(),
      this.ocrHealth.check().then(
        (report) => report.status,
        (): OcrHealthStatus => 'degraded',
      ),
    ]);

    return {
      status: database && redis && storage ? 'ok' : 'degraded',
      database: database ? 'up' : 'down',
      redis: redis ? 'up' : 'down',
      storage: storage ? 'up' : 'down',
      ocr,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
