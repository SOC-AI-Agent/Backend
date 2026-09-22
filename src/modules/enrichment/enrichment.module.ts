import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { CatalogService } from './catalog.service';
import { EnrichmentService } from './enrichment.service';
import { IocService } from './ioc.service';
import { PlaybookService } from './playbook.service';
import { QueryPlanService } from './query-plan.service';
import { SourceMapService } from './source-map.service';
import { SplunkService } from './splunk.service';
import { ThreatQService } from './threatq.service';

@Module({
  imports: [HttpModule],
  providers: [
    CatalogService, IocService, ThreatQService, SourceMapService, QueryPlanService,
    SplunkService, PlaybookService,
    EnrichmentService,
  ],
  exports: [EnrichmentService, IocService, CatalogService, SplunkService, PlaybookService],
})
export class EnrichmentModule {}
