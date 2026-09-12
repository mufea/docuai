import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { User, UserStatus } from '@prisma/client';

/**
 * The only user shape that ever leaves the API. Fields are copied
 * explicitly so new columns (and `passwordHash` in particular) can never be
 * exposed by accident.
 */
export class PublicUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'user@example.com' })
  email!: string;

  @ApiPropertyOptional({ nullable: true, example: 'John Doe' })
  name!: string | null;

  @ApiPropertyOptional({ nullable: true, example: null })
  avatarUrl!: string | null;

  @ApiProperty({ enum: UserStatus })
  status!: UserStatus;

  @ApiProperty({ example: false })
  emailVerified!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export function toPublicUser(user: User): PublicUserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    status: user.status,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
