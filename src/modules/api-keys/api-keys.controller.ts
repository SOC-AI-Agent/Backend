import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthUser } from '../../common/types/auth-user';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/api-key.dto';

@ApiTags('Admin')
@Controller('admin/api-keys')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'analyst')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  list(@CurrentUser() actor: AuthUser) {
    return this.apiKeys.list(actor);
  }

  @Post()
  @HttpCode(201)
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateApiKeyDto) {
    return this.apiKeys.create(actor, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  revoke(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.apiKeys.revoke(actor, id);
  }
}
