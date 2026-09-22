import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';

import { AiService } from '../ai/ai.service';

@ApiTags('System')
@Controller()
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly ai: AiService,
  ) {}

  @Get('health')
  async health() {
    return {
      status: 'ok',
      app: this.config.get<string>('app.appName'),
      model: this.config.get<string>('ai.model'),
      ai_service: (await this.ai.healthy()) ? 'up' : 'down',
    };
  }

  @Get()
  root() {
    return {
      message: `Welcome to ${this.config.get<string>('app.appName')}`,
      docs: '/docs',
    };
  }
}
