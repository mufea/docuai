import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PASSWORD_MAX_LENGTH } from './register.dto';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : (value as unknown),
  )
  @IsEmail()
  @MaxLength(320)
  email!: string;

  /**
   * Only the length ceiling is enforced here; the minimum length is a
   * registration policy and must not leak into login error messages.
   */
  @ApiProperty({ example: 'strong-password', format: 'password' })
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiPropertyOptional({ example: 'Pixel 8', maxLength: 100 })
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : (value as unknown),
  )
  @MinLength(1)
  @MaxLength(100)
  deviceName?: string;
}
