import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AiService } from '../ai/ai.service';
import { HealthResponse, RootResponse } from './dto/health.response';

@ApiTags('System')
@Controller()
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly ai: AiService,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'Is it up', description: 'No authentication. `ai_service` is whether `soc-ai` answered.' })
  @ApiOkResponse({ type: HealthResponse })
  async health() {
    return {
      status: 'ok',
      app: this.config.get<string>('app.appName'),
      model: this.config.get<string>('ai.model'),
      ai_service: (await this.ai.healthy()) ? 'up' : 'down',
    };
  }

  @Get()
  @ApiOperation({ summary: 'Where the docs are' })
  @ApiOkResponse({ type: RootResponse })
  root() {
    return {
      message: `Welcome to ${this.config.get<string>('app.appName')}`,
      docs: '/docs',
    };
  }
}
