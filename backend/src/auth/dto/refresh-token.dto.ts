import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description: 'Opaque refresh token returned by register, login or refresh.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  refreshToken!: string;
}
