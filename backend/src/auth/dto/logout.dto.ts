import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class LogoutDto {
  @ApiProperty({ description: 'Refresh token of the session to terminate.' })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  refreshToken!: string;
}
