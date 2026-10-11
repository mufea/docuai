import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { RequestCtx } from '../common/decorators/request-context.decorator';
import type { RequestContext } from '../common/decorators/request-context.decorator';
import { ApiResult } from '../common/interceptors/response-envelope.interceptor';
import { UuidParamPipe } from '../common/pipes/uuid-param.pipe';
import { PresignThrottle } from './decorators/presign-throttle.decorator';
import { DocumentFilesService } from './document-files.service';
import {
  DocumentDeletionResultDto,
  DocumentDto,
  DownloadUrlResponseDto,
  PaginatedDocumentsDto,
  UploadUrlResponseDto,
  toDocumentDto,
} from './documents.serializer';
import { DocumentsService } from './documents.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateDocumentDto } from './dto/create-document.dto';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { ListDocumentsQueryDto } from './dto/list-documents-query.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';

@ApiTags('Documents')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN',
})
@ApiForbiddenResponse({
  description: 'AUTH_ACCOUNT_SUSPENDED | AUTH_ACCOUNT_DELETED',
})
@UseGuards(ActiveUserGuard)
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly filesService: DocumentFilesService,
  ) {}

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a document (metadata only, status DRAFT)' })
  @ApiCreatedResponse({ type: DocumentDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_ERROR' })
  @ApiNotFoundResponse({ description: 'FOLDER_NOT_FOUND' })
  async create(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateDocumentDto,
    @RequestCtx() ctx: RequestContext,
  ): Promise<DocumentDto> {
    return toDocumentDto(await this.documentsService.create(userId, dto, ctx));
  }

  @Get()
  @ApiOperation({
    summary: "List the caller's documents (paginated, filterable, sortable)",
  })
  @ApiOkResponse({ type: PaginatedDocumentsDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_ERROR' })
  @ApiNotFoundResponse({ description: 'FOLDER_NOT_FOUND (folder filter)' })
  async list(
    @CurrentUser('userId') userId: string,
    @Query() query: ListDocumentsQueryDto,
    @RequestCtx() ctx: RequestContext,
  ): Promise<PaginatedDocumentsDto> {
    const page = await this.documentsService.list(userId, query, ctx);
    return {
      items: page.items.map(toDocumentDto),
      pagination: page.pagination,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retrieve one of the caller’s documents' })
  @ApiOkResponse({ type: DocumentDto })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND' })
  async get(
    @CurrentUser('userId') userId: string,
    @Param('id', UuidParamPipe) id: string,
    @RequestCtx() ctx: RequestContext,
  ): Promise<DocumentDto> {
    return toDocumentDto(await this.documentsService.getOwned(userId, id, ctx));
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update title, description and/or folder. Other fields are rejected.',
  })
  @ApiOkResponse({ type: DocumentDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_ERROR' })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND | FOLDER_NOT_FOUND' })
  async update(
    @CurrentUser('userId') userId: string,
    @Param('id', UuidParamPipe) id: string,
    @Body() dto: UpdateDocumentDto,
    @RequestCtx() ctx: RequestContext,
  ): Promise<DocumentDto> {
    return toDocumentDto(
      await this.documentsService.update(userId, id, dto, ctx),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Soft-delete a document. The file becomes unreachable; a second delete yields DOCUMENT_NOT_FOUND.',
  })
  @ApiOkResponse({ type: DocumentDeletionResultDto })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND' })
  async remove(
    @CurrentUser('userId') userId: string,
    @Param('id', UuidParamPipe) id: string,
    @RequestCtx() ctx: RequestContext,
  ): Promise<ApiResult<DocumentDeletionResultDto>> {
    const result = await this.documentsService.remove(userId, id, ctx);
    return new ApiResult(result, 'Document deleted');
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  @Post(':id/upload-url')
  @HttpCode(HttpStatus.OK)
  @PresignThrottle()
  @ApiOperation({
    summary:
      'Declare a file and receive a short-lived presigned PUT URL. The document becomes UPLOADING.',
  })
  @ApiOkResponse({ type: UploadUrlResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_ERROR' })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND' })
  @ApiConflictResponse({
    description: 'INVALID_UPLOAD (document already has a file)',
  })
  @ApiResponse({ status: 413, description: 'FILE_TOO_LARGE' })
  @ApiResponse({ status: 415, description: 'UNSUPPORTED_FILE_TYPE' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  @ApiResponse({ status: 503, description: 'STORAGE_ERROR' })
  async createUploadUrl(
    @CurrentUser('userId') userId: string,
    @Param('id', UuidParamPipe) id: string,
    @Body() dto: CreateUploadUrlDto,
    @RequestCtx() ctx: RequestContext,
  ): Promise<UploadUrlResponseDto> {
    const { presigned, document } = await this.filesService.createUploadUrl(
      userId,
      id,
      dto,
      ctx,
    );
    return {
      uploadUrl: presigned.url,
      method: 'PUT',
      headers: presigned.headers,
      expiresAt: presigned.expiresAt,
      expiresInSeconds: presigned.expiresInSeconds,
      document: toDocumentDto(document),
    };
  }

  @Post(':id/upload-complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Verify that the file exists in storage with the declared size/type and mark the document READY.',
  })
  @ApiOkResponse({ type: DocumentDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_ERROR' })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND' })
  @ApiConflictResponse({
    description:
      'UPLOAD_NOT_FOUND (nothing uploaded yet) | INVALID_UPLOAD (no upload in progress, or object does not match the declaration → document FAILED)',
  })
  @ApiResponse({ status: 503, description: 'STORAGE_ERROR' })
  async completeUpload(
    @CurrentUser('userId') userId: string,
    @Param('id', UuidParamPipe) id: string,
    @Body() dto: CompleteUploadDto,
    @RequestCtx() ctx: RequestContext,
  ): Promise<DocumentDto> {
    return toDocumentDto(
      await this.filesService.completeUpload(userId, id, dto, ctx),
    );
  }

  @Get(':id/download-url')
  @PresignThrottle()
  @ApiOperation({
    summary: 'Receive a short-lived presigned GET URL for a READY document.',
  })
  @ApiOkResponse({ type: DownloadUrlResponseDto })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND' })
  @ApiConflictResponse({ description: 'UPLOAD_NOT_READY' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  @ApiResponse({ status: 503, description: 'STORAGE_ERROR' })
  async createDownloadUrl(
    @CurrentUser('userId') userId: string,
    @Param('id', UuidParamPipe) id: string,
    @RequestCtx() ctx: RequestContext,
  ): Promise<DownloadUrlResponseDto> {
    const result = await this.filesService.createDownloadUrl(userId, id, ctx);
    return {
      downloadUrl: result.presigned.url,
      method: 'GET',
      expiresAt: result.presigned.expiresAt,
      expiresInSeconds: result.presigned.expiresInSeconds,
      fileName: result.fileName,
      contentType: result.contentType,
      fileSize: result.fileSize,
    };
  }
}
