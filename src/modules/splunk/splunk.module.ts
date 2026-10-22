import { Module } from '@nestjs/common';

import { EnrichmentModule } from '../enrichment/enrichment.module';
import { SplunkController } from './splunk.controller';

@Module({
  imports: [EnrichmentModule],
  controllers: [SplunkController],
})
export class SplunkModule {}
