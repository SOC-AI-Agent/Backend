import {
  BadGatewayException, BadRequestException, ConflictException, Controller, Get, HttpCode, Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadGatewayResponse, ApiBadRequestResponse, ApiConflictResponse, ApiOkResponse, ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JobStatus } from '@prisma/client';

import { ApiRoleAuth } from '../../common/decorators/api-docs.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ErrorResponse } from '../../common/dto/error.response';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AiService } from '../ai/ai.service';
import { PlaybookSyncService } from '../enrichment/playbook-sync.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PlaybookStatusResponse, PlaybookSyncResponse, StatsResponse } from './dto/stats.response';

@ApiTags('Admin')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StatsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ai: AiService,
    private readonly playbookSync: PlaybookSyncService,
  ) {}

  @Get('stats')
  @Roles('admin', 'analyst', 'readonly')
  @ApiRoleAuth('admin', 'analyst', 'readonly')
  @ApiOperation({ summary: 'Job counts and averages' })
  @ApiOkResponse({ type: StatsResponse })
  async stats() {
    const [total, byStatus, completedAgg] = await this.prisma.$transaction([
      this.prisma.aiJob.count(),
      this.prisma.aiJob.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.aiJob.aggregate({
        where: { status: JobStatus.COMPLETED },
        _avg: { processingTimeMs: true },
        _sum: { tokensPrompt: true, tokensEval: true },
      }),
    ]);

    const count = (status: JobStatus) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;

    const completed = count(JobStatus.COMPLETED);
    const totalTokens =
      (completedAgg._sum.tokensPrompt ?? 0) + (completedAgg._sum.tokensEval ?? 0);

    return {
      total_jobs: total,
      pending: count(JobStatus.PENDING),
      processing: count(JobStatus.PROCESSING),
      completed,
      failed: count(JobStatus.FAILED),
      avg_processing_ms: Math.round(completedAgg._avg.processingTimeMs ?? 0),
      total_tokens: totalTokens,
      avg_tokens: completed > 0 ? Math.floor(totalTokens / completed) : 0,
      model: this.config.get<string>('ai.model'),
    };
  }

  @Get('playbooks')
  @Roles('admin', 'analyst', 'readonly')
  @ApiRoleAuth('admin', 'analyst', 'readonly')
  @ApiOperation({
    summary: 'Playbook index and Qdrant status',
    description:
      '`confluence` is this backend\'s side: whether the Confluence settings a sync needs are set. ' +
      'An empty index with `confluence.missing` listed means nothing has ever been synced.',
  })
  @ApiOkResponse({ type: PlaybookStatusResponse })
  async playbooks() {
    const { confluence, syncMinutes } = this.config.get('playbook');
    const missing = this.playbookSync.missingConfig();
    return {
      confluence: {
        configured: missing.length === 0,
        missing,
        base_url: confluence.baseUrl || null,
        space_key: confluence.spaceKey || null,
        sync_minutes: syncMinutes,
      },
      ...(await this.ai.playbookStatus()),
    };
  }

  @Post('playbooks/sync')
  @HttpCode(200)
  @Roles('admin')
  @ApiRoleAuth('admin')
  @ApiOperation({
    summary: 'Sync playbooks from Confluence now',
    description:
      'Reads every page of the Confluence space and sends it to soc-ai, which extracts the ' +
      'playbooks and embeds into Qdrant the fields whose text changed. The worker does the same ' +
      'every PLAYBOOK_SYNC_MINUTES; this is for right after a playbook was edited. Read-only on Confluence.',
  })
  @ApiOkResponse({ type: PlaybookSyncResponse })
  @ApiBadRequestResponse({ type: ErrorResponse, description: 'CONFLUENCE_* unset in Backend/.env.' })
  @ApiConflictResponse({ type: ErrorResponse, description: 'A sync is already running.' })
  @ApiBadGatewayResponse({ type: ErrorResponse, description: 'Confluence or soc-ai failed; soc-ai keeps its last index.' })
  async syncPlaybooks() {
    const missing = this.playbookSync.missingConfig();
    if (missing.length) {
      throw new BadRequestException(
        `${missing.join(', ')} unset in Backend/.env: there is no Confluence space to sync from`,
      );
    }
    if (this.playbookSync.busy) throw new ConflictException('A playbook sync is already running');

    const state = await this.playbookSync.sync();
    if (!state.ok) throw new BadGatewayException(state.error ?? 'playbook sync failed');
    return {
      sync: {
        ok: true,
        at: state.at?.toISOString() ?? null,
        pages: state.pages,
        playbooks: state.playbooks,
        embedded: state.embedded,
        reused: state.reused,
      },
      index: await this.playbooks(),
    };
  }
}
