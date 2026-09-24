import { Body, Controller, Get, HttpCode, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Request } from 'express';

import { ApiJwtAuth } from '../../common/decorators/api-docs.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ErrorResponse } from '../../common/dto/error.response';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { clientIp } from '../../common/request-context';
import { AuthUser } from '../../common/types/auth-user';
import { AuditService } from '../audit/audit.service';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto } from './dto/login.dto';
import { MeResponse, TokenResponse } from './dto/token.response';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in', description: 'Returns a token pair. Send `access_token` as `Authorization: Bearer …`, or paste it into Authorize.' })
  @ApiOkResponse({ type: TokenResponse })
  @ApiUnauthorizedResponse({ type: ErrorResponse, description: 'Wrong username or password.' })
  async login(@Body() body: LoginDto, @Req() req: Request) {
    const user = await this.auth.authenticate(body.username, body.password);

    if (!user) {
      await this.audit.log({
        eventType: 'AUTH_FAILED',
        actorType: 'USER',
        actorLabel: body.username,
        endpoint: '/auth/login',
        httpMethod: 'POST',
        ipAddress: clientIp(req),
        statusCode: 401,
      });
      throw new UnauthorizedException('Invalid username or password');
    }

    const tokens = await this.auth.issueTokens(user);
    await this.audit.log({
      eventType: 'AUTH_LOGIN',
      actorType: 'USER',
      actorId: user.id,
      actorLabel: user.username,
      endpoint: '/auth/login',
      httpMethod: 'POST',
      ipAddress: clientIp(req),
      statusCode: 200,
    });
    return tokens;
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange a refresh token for a new pair' })
  @ApiOkResponse({ type: TokenResponse })
  @ApiUnauthorizedResponse({ type: ErrorResponse, description: 'The refresh token is invalid, expired or revoked.' })
  async refresh(@Body() body: RefreshDto) {
    const tokens = await this.auth.refresh(body.refresh_token);
    if (!tokens) throw new UnauthorizedException('Invalid or expired refresh token');
    return tokens;
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiJwtAuth()
  @ApiOperation({ summary: 'Who the token belongs to' })
  @ApiOkResponse({ type: MeResponse })
  me(@CurrentUser() user: AuthUser) {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role.name,
      is_active: user.isActive,
    };
  }
}
