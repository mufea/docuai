import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { RequestCtx } from '../common/decorators/request-context.decorator';
import type { RequestContext } from '../common/decorators/request-context.decorator';
import { ApiResult } from '../common/interceptors/response-envelope.interceptor';
import { UuidParamPipe } from '../common/pipes/uuid-param.pipe';
import { OcrThrottle } from './decorators/ocr-throttle.decorator';
import { OcrResultsQueryDto } from './dto/ocr-results-query.dto';
import { RequestOcrDto } from './dto/request-ocr.dto';
import { OcrService } from './ocr.service';
import {
  OcrJobDto,
  OcrResultsDto,
  toOcrJobDto,
  toOcrPageDto,
} from './ocr.serializer';

@ApiTags('OCR')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'UNAUTHORIZED / TOKEN_EXPIRED / TOKEN_INVALID',
})
@ApiForbiddenResponse({ description: 'ACCOUNT_SUSPENDED' })
@ApiParam({
  name: 'id',
  format: 'uuid',
  description: 'Document id (must belong to the caller)',
})
@UseGuards(ActiveUserGuard)
@Controller('documents/:id/ocr')
export class OcrController {
  constructor(private readonly ocrService: OcrService) {}

  @Post()
  @OcrThrottle()
  @ApiOperation({
    summary: 'Request text extraction / OCR for a READY document',
    description:
      'Queues an asynchronous job. 202 when a new job was created; 200 when a compatible active job or a finished job for the same language already exists (unless forceReprocess).',
  })
  @ApiAcceptedResponse({ type: OcrJobDto, description: 'New job queued' })
  @ApiOkResponse({
    type: OcrJobDto,
    description: 'Existing active or finished job returned',
  })
  @ApiBadRequestResponse({
    description: 'VALIDATION_ERROR / OCR_UNSUPPORTED_LANGUAGE',
  })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND' })
  @ApiConflictResponse({
    description: 'OCR_DOCUMENT_NOT_READY / OCR_ALREADY_PROCESSING',
  })
  @ApiTooManyRequestsResponse({
    description: 'RATE_LIMITED / OCR_TOO_MANY_JOBS',
  })
  async request(
    @CurrentUser('userId') userId: string,
    @Param('id', UuidParamPipe) id: string,
    @Body() dto: RequestOcrDto,
    @RequestCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResult<OcrJobDto>> {
    const { job, outcome } = await this.ocrService.request(
      userId,
      id,
      dto,
      ctx,
    );
    if (outcome === 'created') {
      res.status(HttpStatus.ACCEPTED);
      return new ApiResult(toOcrJobDto(job), 'OCR job queued');
    }
    res.status(HttpStatus.OK);
    return new ApiResult(
      toOcrJobDto(job),
      outcome === 'active'
        ? 'An OCR job for this document is already in progress'
        : 'OCR results for this language already exist; pass forceReprocess to run again',
    );
  }

  @Get()
  @ApiOperation({ summary: 'Latest OCR job status for the document' })
  @ApiOkResponse({ type: OcrJobDto })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND / OCR_NOT_FOUND' })
  async status(
    @CurrentUser('userId') userId: string,
    @Param('id', UuidParamPipe) id: string,
    @RequestCtx() ctx: RequestContext,
  ): Promise<OcrJobDto> {
    return toOcrJobDto(await this.ocrService.status(userId, id, ctx));
  }

  @Get('results')
  @ApiOperation({
    summary: 'Page-level extracted text of the latest (or a given) OCR job',
    description:
      'Pages are ordered by pageNumber (1-based). Only terminal jobs have results; QUEUED/PROCESSING answer 409 OCR_NOT_READY.',
  })
  @ApiOkResponse({ type: OcrResultsDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_ERROR' })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND / OCR_NOT_FOUND' })
  @ApiConflictResponse({ description: 'OCR_NOT_READY' })
  async results(
    @CurrentUser('userId') userId: string,
    @Param('id', UuidParamPipe) id: string,
    @Query() query: OcrResultsQueryDto,
    @RequestCtx() ctx: RequestContext,
  ): Promise<OcrResultsDto> {
    const { job, pages, pagination } = await this.ocrService.results(
      userId,
      id,
      query,
      ctx,
    );
    return {
      jobId: job.id,
      documentId: job.documentId,
      status: job.status,
      language: job.language,
      extractionMethod: job.extractionMethod,
      totalPages: job.totalPages,
      errorCode: job.errorCode,
      pages: pages.map(toOcrPageDto),
      pagination,
    };
  }

  @Post('retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @OcrThrottle()
  @ApiOperation({
    summary: 'Retry the latest FAILED or PARTIAL job as a new job',
    description:
      'Creates a new job with the same language. Refused for active, COMPLETED or CANCELLED jobs and for permanent failures (invalid/unsupported/oversized file).',
  })
  @ApiAcceptedResponse({ type: OcrJobDto })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND / OCR_NOT_FOUND' })
  @ApiConflictResponse({
    description: 'OCR_RETRY_NOT_ALLOWED / OCR_DOCUMENT_NOT_READY',
  })
  @ApiTooManyRequestsResponse({
    description: 'RATE_LIMITED / OCR_TOO_MANY_JOBS',
  })
  async retry(
    @CurrentUser('userId') userId: string,
    @Param('id', UuidParamPipe) id: string,
    @RequestCtx() ctx: RequestContext,
  ): Promise<ApiResult<OcrJobDto>> {
    const job = await this.ocrService.retry(userId, id, ctx);
    return new ApiResult(toOcrJobDto(job), 'OCR retry queued');
  }
}
