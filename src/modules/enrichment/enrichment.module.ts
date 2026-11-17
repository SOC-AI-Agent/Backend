import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { CatalogService } from './catalog.service';
import { EnrichmentService } from './enrichment.service';
import { FieldProbeService } from './field-probe.service';
import { IocService } from './ioc.service';
import { PlaybookSyncService } from './playbook-sync.service';
import { PlaybookService } from './playbook.service';
import { QueryPlanService } from './query-plan.service';
import { SourceMapService } from './source-map.service';
import { SplunkMcpService } from './splunk-mcp.service';
import { ThreatQService } from './threatq.service';

@Module({
  imports: [HttpModule],
  providers: [
    CatalogService, IocService, ThreatQService, SourceMapService, QueryPlanService,
    SplunkMcpService, PlaybookService, PlaybookSyncService, FieldProbeService,
    EnrichmentService,
  ],
  exports: [
    EnrichmentService, IocService, CatalogService, SplunkMcpService, PlaybookService,
    PlaybookSyncService, FieldProbeService,
  ],
})
export class EnrichmentModule {}
