import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';
import type { AppConfiguration } from '../config/configuration';

describe('RedisService', () => {
  let redis: RedisService;

  beforeAll(async () => {
    const config = {
      get: (key: keyof AppConfiguration) => {
        if (key === 'redisUrl') {
          return process.env.REDIS_URL;
        }
        return undefined;
      },
    };

    redis = new RedisService(
      config as unknown as ConfigService<AppConfiguration>,
    );
    await redis.onModuleInit();
  });

  afterAll(async () => {
    await redis.onModuleDestroy();
  });

  it('initializes and responds to ping', async () => {
    await expect(redis.ping()).resolves.toBe('PONG');
  });

  it('supports get, set, and del', async () => {
    const key = `docuai:phase0:${Date.now()}`;
    await redis.set(key, 'ok', 30);
    await expect(redis.get(key)).resolves.toBe('ok');
    await expect(redis.del(key)).resolves.toBe(1);
    await expect(redis.get(key)).resolves.toBeNull();
  });

  it('reports healthy when Redis is reachable', async () => {
    await expect(redis.isHealthy()).resolves.toBe(true);
  });
});
