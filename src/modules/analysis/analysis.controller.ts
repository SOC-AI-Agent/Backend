import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { CurrentApiKey } from '../../common/decorators/api-key.decorator';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { clientIp } from '../../common/request-context';
import { ApiKeyRecord } from '../../common/types/auth-user';
import { AnalysisService } from './analysis.service';
import { AnalyzeDto, ListResultsQuery } from './dto/analysis.dto';

@ApiTags('Analysis')
@Controller('v1')
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  /** SOAR entry point — accepts the alert and returns a job_id immediately. */
  @Post('analyze')
  @HttpCode(202)
  @UseGuards(ApiKeyGuard)
  analyze(
    @Body() dto: AnalyzeDto,
    @CurrentApiKey() apiKey: ApiKeyRecord,
    @Req() req: Request,
  ) {
    return this.analysis.enqueue(dto, apiKey, clientIp(req));
  }

  /** Dashboard job list. */
  @Get('results')
  @UseGuards(JwtAuthGuard)
  list(@Query() query: ListResultsQuery) {
    return this.analysis.list(query);
  }

  /** SOAR polls here with its API key. */
  @Get('results/:jobId')
  @UseGuards(ApiKeyGuard)
  result(@Param('jobId') jobId: string) {
    return this.analysis.findOne(jobId);
  }

  /** Dashboard job detail. */
  @Get('jobs/:jobId')
  @UseGuards(JwtAuthGuard)
  job(@Param('jobId') jobId: string) {
    return this.analysis.findOne(jobId);
  }

  /**
   * Run the Splunk stage for this job — the button on the job page.
   *
   * Behind the dashboard's guard, not the API key's: this spends minutes of
   * inference per requirement, and it should be a person deciding that about a
   * particular alert rather than a playbook doing it to every one.
   */
  @Post('jobs/:jobId/lookup')
  @HttpCode(202)
  @UseGuards(JwtAuthGuard)
  lookup(@Param('jobId') jobId: string, @Req() req: Request) {
    const user = (req as Request & { user?: { username?: string } }).user;
    return this.analysis.requestLookup(jobId, user?.username ?? 'dashboard');
  }
}
