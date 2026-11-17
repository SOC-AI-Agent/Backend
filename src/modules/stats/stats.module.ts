import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { StatsController } from './stats.controller';

@Module({
  imports: [AiModule],
  controllers: [StatsController],
})
export class StatsModule {}
