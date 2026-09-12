import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { DependencyUnavailableException } from '../common/exceptions/dependency-unavailable.exception';
import type { HealthSnapshot } from './health.types';

describe('HealthController', () => {
  const healthService = {
    check: jest.fn(),
  };

  const controller = new HealthController(
    healthService as unknown as HealthService,
  );

  it('returns the health snapshot when dependencies are up', async () => {
    const snapshot: HealthSnapshot = {
      status: 'ok',
      service: 'DocuAI API',
      database: 'up',
      redis: 'up',
    };
    healthService.check.mockResolvedValue(snapshot);

    await expect(controller.check()).resolves.toEqual(snapshot);
  });

  it('throws when a dependency is unavailable', async () => {
    const snapshot: HealthSnapshot = {
      status: 'error',
      service: 'DocuAI API',
      database: 'down',
      redis: 'up',
    };
    healthService.check.mockResolvedValue(snapshot);

    await expect(controller.check()).rejects.toBeInstanceOf(
      DependencyUnavailableException,
    );
  });
});
