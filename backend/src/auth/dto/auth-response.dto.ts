import { ApiProperty } from '@nestjs/swagger';
import { PublicUserDto } from '../../users/users.serializer';

export class TokenPairDto {
  @ApiProperty({
    description: 'Short-lived JWT for the Authorization: Bearer header.',
  })
  accessToken!: string;

  @ApiProperty({
    description:
      'Opaque, single-use refresh token. Store securely on the device.',
  })
  refreshToken!: string;

  @ApiProperty({
    example: 900,
    description: 'Access token lifetime in seconds.',
  })
  expiresIn!: number;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: 'Bearer';
}

export class AuthResponseDto extends TokenPairDto {
  @ApiProperty({ type: PublicUserDto })
  user!: PublicUserDto;
}
