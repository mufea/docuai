import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AppConfiguration } from '../config/configuration';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  constructor(
    private readonly configService: ConfigService<AppConfiguration>,
  ) {}

  async onModuleInit(): Promise<void> {
    const url = this.configService.get('redisUrl', { infer: true });
    if (!url) {
      throw new Error('Invalid configuration: REDIS_URL is required');
    }

    this.client = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      enableOfflineQueue: false,
      lazyConnect: true,
    });

    this.client.on('error', (error: Error) => {
      this.logger.warn({
        msg: 'Redis client error',
        error: error.name,
      });
    });

    await this.client.connect();
    this.logger.log('Redis connection established');
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.client.quit();
    this.logger.log('Redis connection closed');
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.setex(key, ttlSeconds, value);
      return;
    }

    await this.client.set(key, value);
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.ping();
      return result === 'PONG';
    } catch (error) {
      this.logger.warn({
        msg: 'Redis health check failed',
        error: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }
  }

  getClient(): Redis {
    return this.client;
  }
}
