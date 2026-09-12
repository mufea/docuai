import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Only `name` and `avatarUrl` are editable. Any other property (email,
 * status, emailVerified, passwordHash, ...) is rejected by the global
 * `forbidNonWhitelisted` validation and therefore can never reach the
 * database.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({
    example: 'Jane Doe',
    minLength: 1,
    maxLength: 100,
    nullable: true,
    description: 'Display name. Send null to clear.',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : (value as unknown),
  )
  @MinLength(1)
  @MaxLength(100)
  name?: string | null;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/avatars/jane.png',
    maxLength: 2048,
    nullable: true,
    description:
      'Absolute http(s) URL of the avatar image. Send null to clear.',
  })
  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  avatarUrl?: string | null;
}
