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
import { OcrErrorCodes } from '../ocr/ocr.errors';
import { OcrHealthReport, OcrHealthService } from '../ocr/ocr-health.service';
import {
  HEALTH_DEPENDENCIES,
  HealthReport,
  HealthService,
} from './health.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly ocrHealthService: OcrHealthService,
  ) {}

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
      const down = HEALTH_DEPENDENCIES.filter(
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

  @Public()
  @Get('ocr')
  @SkipThrottle()
  @ApiOperation({
    summary: 'OCR readiness: engine, renderer, language data, queue and worker',
    description:
      'Separate from the main probe so OCR dependency problems never fail unrelated requests. 503 when OCR is enabled but not ready.',
  })
  @ApiOkResponse({
    description: 'OCR dependencies available (or OCR disabled)',
  })
  @ApiServiceUnavailableResponse({ description: 'OCR_UNAVAILABLE' })
  async ocr(): Promise<OcrHealthReport> {
    const report = await this.ocrHealthService.check();
    if (report.status === 'degraded') {
      const problems = [
        ...(report.engine.available ? [] : ['engine']),
        ...(report.renderer.available ? [] : ['renderer']),
        ...(report.languages.defaultAvailable ? [] : ['default language data']),
        ...(report.queue.status === 'up' ? [] : ['queue']),
        ...(report.worker.state === 'running' ||
        report.worker.state === 'disabled'
          ? []
          : ['worker']),
      ];
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        OcrErrorCodes.OCR_UNAVAILABLE,
        `OCR dependencies unavailable: ${problems.join(', ') || 'unknown'}`,
      );
    }
    return report;
  }
}
