import { Module } from '@nestjs/common';
import { FoldersModule } from '../folders/folders.module';
import { UsersModule } from '../users/users.module';
import { DocumentFilesService } from './document-files.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  imports: [UsersModule, FoldersModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentFilesService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
