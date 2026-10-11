import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { S3StorageProvider } from './s3/s3-storage.provider';
import { StorageProvider } from './storage.provider';

/**
 * Binds the abstract `StorageProvider` to the implementation selected by
 * `STORAGE_PROVIDER`. Only `s3` (any S3-compatible API) exists in Phase 2;
 * a new backend is added here without touching the Documents module.
 */
@Global()
@Module({
  providers: [
    {
      provide: StorageProvider,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => {
        const { provider } = configService.get('storage', { infer: true });
        switch (provider) {
          case 's3':
            return new S3StorageProvider(configService);
          default:
            throw new Error(
              `Unsupported STORAGE_PROVIDER "${String(provider)}"`,
            );
        }
      },
    },
  ],
  exports: [StorageProvider],
})
export class StorageModule {}
