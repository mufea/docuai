import { Controller, Get, HttpStatus } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { ErrorCodes } from '../common/constants/error-codes';
import { AppException } from '../common/exceptions/app.exception';
import { HealthReport, HealthService } from './health.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Get()
  @SkipThrottle()
  @ApiOperation({
    summary: 'Liveness/readiness probe for the API and its dependencies',
  })
  @ApiOkResponse({ description: 'All dependencies are reachable' })
  @ApiServiceUnavailableResponse({
    description: 'One or more dependencies are down',
  })
  async check(): Promise<HealthReport> {
    const report = await this.healthService.check();

    if (report.status !== 'ok') {
      const down = (['database', 'redis'] as const).filter(
        (dependency) => report[dependency] === 'down',
      );
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCodes.SERVICE_UNAVAILABLE,
        `Dependencies unavailable: ${down.join(', ')}`,
      );
    }

    return report;
  }
}
