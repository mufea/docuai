import { Global, Module } from '@nestjs/common';
import { PasswordService } from './password.service';
import { SecurityEventsService } from './security-events.service';

@Global()
@Module({
  providers: [PasswordService, SecurityEventsService],
  exports: [PasswordService, SecurityEventsService],
})
export class SecurityModule {}
