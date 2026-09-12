import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { PublicUserDto, toPublicUser } from './users.serializer';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN',
})
@ApiForbiddenResponse({
  description: 'AUTH_ACCOUNT_SUSPENDED | AUTH_ACCOUNT_DELETED',
})
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: "Return the authenticated user's profile" })
  @ApiOkResponse({ type: PublicUserDto })
  async me(@CurrentUser('userId') userId: string): Promise<PublicUserDto> {
    return toPublicUser(await this.usersService.getActiveUser(userId));
  }

  @Patch('me')
  @ApiOperation({
    summary:
      'Update profile fields (name, avatarUrl). Other fields are rejected.',
  })
  @ApiOkResponse({ type: PublicUserDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_ERROR' })
  async updateMe(
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateProfileDto,
  ): Promise<PublicUserDto> {
    await this.usersService.getActiveUser(userId);
    return toPublicUser(await this.usersService.updateProfile(userId, dto));
  }
}
