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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { RequestCtx } from '../common/decorators/request-context.decorator';
import type { RequestContext } from '../common/decorators/request-context.decorator';
import { ApiResult } from '../common/interceptors/response-envelope.interceptor';
import { UuidParamPipe } from '../common/pipes/uuid-param.pipe';
import { CreateFolderDto } from './dto/create-folder.dto';
import { ListFoldersQueryDto } from './dto/list-folders-query.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import {
  FolderDeletionResultDto,
  FolderDto,
  toFolderDto,
} from './folders.serializer';
import { FoldersService } from './folders.service';

@ApiTags('Folders')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN',
})
@ApiForbiddenResponse({
  description: 'AUTH_ACCOUNT_SUSPENDED | AUTH_ACCOUNT_DELETED',
})
@UseGuards(ActiveUserGuard)
@Controller('folders')
export class FoldersController {
  constructor(private readonly foldersService: FoldersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a folder (optionally inside a parent)' })
  @ApiCreatedResponse({ type: FolderDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_ERROR | FOLDER_DEPTH_EXCEEDED',
  })
  @ApiNotFoundResponse({ description: 'FOLDER_NOT_FOUND (parent)' })
  async create(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateFolderDto,
    @RequestCtx() ctx: RequestContext,
  ): Promise<FolderDto> {
    return toFolderDto(await this.foldersService.create(userId, dto, ctx));
  }

  @Get()
  @ApiOperation({
    summary: "List the caller's folders, optionally filtered by parent",
  })
  @ApiOkResponse({ type: FolderDto, isArray: true })
  @ApiBadRequestResponse({ description: 'VALIDATION_ERROR' })
  @ApiNotFoundResponse({ description: 'FOLDER_NOT_FOUND (parent filter)' })
  async list(
    @CurrentUser('userId') userId: string,
    @Query() query: ListFoldersQueryDto,
    @RequestCtx() ctx: RequestContext,
  ): Promise<FolderDto[]> {
    const folders = await this.foldersService.list(userId, query.parentId, ctx);
    return folders.map(toFolderDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retrieve one of the caller’s folders' })
  @ApiOkResponse({ type: FolderDto })
  @ApiNotFoundResponse({ description: 'FOLDER_NOT_FOUND' })
  async get(
    @CurrentUser('userId') userId: string,
    @Param('id', UuidParamPipe) id: string,
    @RequestCtx() ctx: RequestContext,
  ): Promise<FolderDto> {
    return toFolderDto(await this.foldersService.getOwned(userId, id, ctx));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename and/or move a folder' })
  @ApiOkResponse({ type: FolderDto })
  @ApiBadRequestResponse({
    description:
      'VALIDATION_ERROR | INVALID_FOLDER | FOLDER_CYCLE_DETECTED | FOLDER_DEPTH_EXCEEDED',
  })
  @ApiNotFoundResponse({ description: 'FOLDER_NOT_FOUND' })
  async update(
    @CurrentUser('userId') userId: string,
    @Param('id', UuidParamPipe) id: string,
    @Body() dto: UpdateFolderDto,
    @RequestCtx() ctx: RequestContext,
  ): Promise<FolderDto> {
    return toFolderDto(await this.foldersService.update(userId, id, dto, ctx));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Delete a folder. Documents move to the root, child folders are promoted to the deleted folder’s parent.',
  })
  @ApiOkResponse({ type: FolderDeletionResultDto })
  @ApiNotFoundResponse({ description: 'FOLDER_NOT_FOUND' })
  async remove(
    @CurrentUser('userId') userId: string,
    @Param('id', UuidParamPipe) id: string,
    @RequestCtx() ctx: RequestContext,
  ): Promise<ApiResult<FolderDeletionResultDto>> {
    const result = await this.foldersService.remove(userId, id, ctx);
    return new ApiResult(result, 'Folder deleted');
  }
}
