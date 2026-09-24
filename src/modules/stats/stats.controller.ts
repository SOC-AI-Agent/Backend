import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JobStatus } from '@prisma/client';

import { ApiRoleAuth } from '../../common/decorators/api-docs.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { StatsResponse } from './dto/stats.response';

@ApiTags('Admin')
@Controller('admin/stats')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StatsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get()
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
}
