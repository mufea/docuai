import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

describe('HealthService', () => {
  let service: HealthService;
  let prisma: { isHealthy: jest.Mock };
  let redis: { isHealthy: jest.Mock };

  beforeEach(async () => {
    prisma = { isHealthy: jest.fn() };
    redis = { isHealthy: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get(HealthService);
  });

  it('reports ok when PostgreSQL and Redis are available', async () => {
    prisma.isHealthy.mockResolvedValue(true);
    redis.isHealthy.mockResolvedValue(true);

    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      service: 'DocuAI API',
      database: 'up',
      redis: 'up',
    });
  });

  it('reports database down without claiming Redis is down', async () => {
    prisma.isHealthy.mockResolvedValue(false);
    redis.isHealthy.mockResolvedValue(true);

    await expect(service.check()).resolves.toEqual({
      status: 'error',
      service: 'DocuAI API',
      database: 'down',
      redis: 'up',
    });
  });

  it('reports redis down without claiming PostgreSQL is down', async () => {
    prisma.isHealthy.mockResolvedValue(true);
    redis.isHealthy.mockResolvedValue(false);

    await expect(service.check()).resolves.toEqual({
      status: 'error',
      service: 'DocuAI API',
      database: 'up',
      redis: 'down',
    });
  });
});
