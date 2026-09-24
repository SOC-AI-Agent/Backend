import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiForbiddenResponse,
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
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/api-key.dto';
import { ApiKeyResponse, CreatedApiKeyResponse } from './dto/api-key.response';

@ApiTags('Admin')
@Controller('admin/api-keys')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'analyst')
@ApiRoleAuth('admin', 'analyst')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @ApiOperation({ summary: 'List API keys', description: 'An admin sees every key; anyone else sees their own.' })
  @ApiOkResponse({ type: [ApiKeyResponse] })
  list(@CurrentUser() actor: AuthUser) {
    return this.apiKeys.list(actor);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an API key', description: 'The full key is in this response and **never shown again** — only its hash is stored. Send it as `X-API-Key`.' })
  @ApiCreatedResponse({ type: CreatedApiKeyResponse })
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateApiKeyDto) {
    return this.apiKeys.create(actor, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiNoContentResponse({ description: 'Revoked.' })
  @ApiNotFoundResponse({ type: ErrorResponse, description: 'No such key.' })
  @ApiForbiddenResponse({ type: ErrorResponse, description: 'The key belongs to someone else (and you are not an admin).' })
  revoke(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.apiKeys.revoke(actor, id);
  }
}
