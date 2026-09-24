import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { ApiRoleAuth } from '../../common/decorators/api-docs.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ErrorResponse } from '../../common/dto/error.response';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthUser } from '../../common/types/auth-user';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { UserResponse } from './dto/user.response';
import { UsersService } from './users.service';

@ApiTags('Admin')
@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiRoleAuth('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List users' })
  @ApiOkResponse({ type: [UserResponse] })
  list() {
    return this.users.list();
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a user', description: 'The first admin is created this way once one exists, or by hand (docs/setup.md); the seed creates roles only.' })
  @ApiCreatedResponse({ type: UserResponse })
  @ApiBadRequestResponse({ type: ErrorResponse, description: 'Invalid field, unknown role, or the username already exists.' })
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateUserDto) {
    return this.users.create(actor, dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a user' })
  @ApiOkResponse({ type: UserResponse })
  @ApiNotFoundResponse({ type: ErrorResponse, description: 'No such user.' })
  @ApiBadRequestResponse({ type: ErrorResponse, description: 'Invalid field or unknown role.' })
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a user' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiNotFoundResponse({ type: ErrorResponse, description: 'No such user.' })
  @ApiBadRequestResponse({ type: ErrorResponse, description: 'You cannot delete yourself.' })
  remove(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.users.remove(actor, id);
  }
}
