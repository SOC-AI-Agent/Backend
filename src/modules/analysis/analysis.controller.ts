import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';

import { ApiApiKeyAuth, ApiJwtAuth } from '../../common/decorators/api-docs.decorator';
import { CurrentApiKey } from '../../common/decorators/api-key.decorator';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { clientIp } from '../../common/request-context';
import { ErrorResponse } from '../../common/dto/error.response';
import { ApiKeyRecord } from '../../common/types/auth-user';
import { AnalysisService } from './analysis.service';
import { AnalyzeDto, ListResultsQuery } from './dto/analysis.dto';
import {
  EnqueueResponse,
  JobDetailResponse,
  JobListResponse,
  LookupRequestedResponse,
} from './dto/job.response';

@ApiTags('Analysis')
@Controller('v1')
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  /** SOAR entry point — accepts the alert and returns a job_id immediately. */
  @Post('analyze')
  @HttpCode(202)
  @UseGuards(ApiKeyGuard)
  @ApiApiKeyAuth()
  @ApiOperation({
    summary: 'Submit an alert for triage',
    description:
      'Returns a `job_id` at once; the work happens afterwards. Poll `GET /v1/results/{job_id}`. ' +
      'The first answer is a suggestion written from the alert, ThreatQ and the playbook; ' +
      'searching Splunk is a separate, later step. A `prompt` field is ignored: the agents own their instructions.',
  })
  @ApiAcceptedResponse({ type: EnqueueResponse })
  @ApiBadRequestResponse({ type: ErrorResponse, description: 'A required field is missing or empty. `detail` names it.' })
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
  @ApiJwtAuth()
  @ApiOperation({ summary: 'List jobs, newest first', description: 'Without `evidence`, `lookup_result` or `final_analysis` — those are on the detail.' })
  @ApiOkResponse({ type: JobListResponse })
  list(@Query() query: ListResultsQuery) {
    return this.analysis.list(query);
  }

  /** SOAR polls here with its API key. */
  @Get('results/:jobId')
  @UseGuards(ApiKeyGuard)
  @ApiApiKeyAuth()
  @ApiOperation({
    summary: 'Read one job (API key)',
    description: 'What a SOAR playbook polls. `status` goes `pending`, `processing`, then `completed` or `failed`.',
  })
  @ApiOkResponse({ type: JobDetailResponse })
  @ApiNotFoundResponse({ type: ErrorResponse, description: 'No such job.' })
  result(@Param('jobId') jobId: string) {
    return this.analysis.findOne(jobId);
  }

  /** Dashboard job detail. */
  @Get('jobs/:jobId')
  @UseGuards(JwtAuthGuard)
  @ApiJwtAuth()
  @ApiOperation({ summary: 'Read one job (dashboard)', description: 'The same detail as `GET /v1/results/{job_id}`, for a signed-in user.' })
  @ApiOkResponse({ type: JobDetailResponse })
  @ApiNotFoundResponse({ type: ErrorResponse, description: 'No such job.' })
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
  @ApiJwtAuth()
  @ApiOperation({
    summary: 'Search Splunk for what stage 1 asked for',
    description:
      'Runs exactly the requirements stage 1 stored, then an agent with no tools reads the results and writes ' +
      '`final_analysis`. Poll `GET /v1/jobs/{job_id}`: `lookup_status` stays `running` until the analysis is written too.',
  })
  @ApiAcceptedResponse({ type: LookupRequestedResponse })
  @ApiBadRequestResponse({ type: ErrorResponse, description: 'The suggestion is not ready yet, or it asked for nothing to look up.' })
  @ApiNotFoundResponse({ type: ErrorResponse, description: 'No such job.' })
  @ApiConflictResponse({ type: ErrorResponse, description: 'A lookup for this job is already queued or running.' })
  lookup(@Param('jobId') jobId: string, @Req() req: Request) {
    const user = (req as Request & { user?: { username?: string } }).user;
    return this.analysis.requestLookup(jobId, user?.username ?? 'dashboard');
  }
}
