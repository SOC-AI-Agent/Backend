import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StatsController } from './stats.controller';

@Module({
  imports: [AiModule, EnrichmentModule],
  controllers: [StatsController],
})
export class StatsModule {}
