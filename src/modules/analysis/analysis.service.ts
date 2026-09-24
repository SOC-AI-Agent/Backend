import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AiJob, JobStatus, LookupStatus, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';

import { ApiKeyRecord } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  ANALYSIS_QUEUE,
  ANALYZE_ALERT_JOB,
  AnalyzeAlertPayload,
} from '../queue/analysis-job.payload';
import {
  LOOKUP_QUEUE,
  RUN_LOOKUP_JOB,
  SplunkLookupPayload,
} from '../queue/lookup-job.payload';
import { splitLookup } from '../queue/lookup-job.payload';
import { AnalyzeDto, ListResultsQuery } from './dto/analysis.dto';

@Injectable()
export class AnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectQueue(ANALYSIS_QUEUE) private readonly queue: Queue<AnalyzeAlertPayload>,
    @InjectQueue(LOOKUP_QUEUE) private readonly lookupQueue: Queue<SplunkLookupPayload>,
  ) {}

  /**
   * Persist the alert as a PENDING job, hand it to the queue and return at once.
   * The BullMQ job id is the job_id, so a retried SOAR call is not queued twice.
   */
  async enqueue(
    dto: AnalyzeDto,
    apiKey: ApiKeyRecord,
    ipAddress: string | null,
  ): Promise<{ job_id: string; status: string; estimated_wait_seconds: number }> {
    const job = await this.prisma.aiJob.create({
      data: {
        alertId: dto.alert_id,
        alertName: dto.alert_name,
        rawLog: dto.raw_log,
        apiKeyId: apiKey.id,
        ownerId: apiKey.ownerId,
        status: JobStatus.PENDING,
      },
    });

    await this.audit.log({
      eventType: 'ANALYZE_REQUEST',
      actorType: 'API_KEY',
      actorId: apiKey.id,
      actorLabel: apiKey.keyPrefix,
      endpoint: '/v1/analyze',
      httpMethod: 'POST',
      ipAddress,
      jobId: job.jobId,
      statusCode: 202,
      extraData: { alert_id: dto.alert_id, alert_name: dto.alert_name },
    });

    await this.queue.add(
      ANALYZE_ALERT_JOB,
      {
        jobId: job.jobId,
        alertId: dto.alert_id,
        alertName: dto.alert_name,
        rawLog: dto.raw_log,
        indicators: dto.indicators?.map((i) => ({
          type: i.type,
          value: i.value,
          source: i.source ?? 'soar',
        })),
        apiKeyId: apiKey.id,
        actorLabel: apiKey.keyPrefix,
        ipAddress,
      },
      { jobId: job.jobId },
    );

    await this.audit.log({
      eventType: 'JOB_QUEUED',
      actorType: 'SYSTEM',
      jobId: job.jobId,
      extraData: { alert_id: dto.alert_id },
    });

    return { job_id: job.jobId, status: 'queued', estimated_wait_seconds: 60 };
  }

  async findOne(jobId: string) {
    const job = await this.prisma.aiJob.findUnique({ where: { jobId } });
    if (!job) throw new NotFoundException('Job not found');
    return toJobResponse(job, true);
  }

  /**
   * Ask for the Splunk stage on one job.
   *
   * What stage 1 wrote down is what gets run — this does not re-derive the
   * requirements from the alert. The analyst read those lines before pressing
   * the button, and searching for something else would make the button a lie.
   */
  async requestLookup(jobId: string, requestedBy: string) {
    const job = await this.prisma.aiJob.findUnique({ where: { jobId } });
    if (!job) throw new NotFoundException('Job not found');

    if (job.status !== JobStatus.COMPLETED) {
      throw new BadRequestException(
        `the suggestion is not ready yet (job is ${job.status.toLowerCase()})`,
      );
    }

    const requirements = (job.splunkRequirements ?? []) as string[];
    if (!Array.isArray(requirements) || requirements.length === 0) {
      throw new BadRequestException('this alert produced nothing to look up');
    }

    // QUEUED and RUNNING are both "already happening". Re-queueing would spend
    // the same minutes of inference twice and overwrite the first run's answers
    // with the second's.
    if (job.lookupStatus === LookupStatus.QUEUED || job.lookupStatus === LookupStatus.RUNNING) {
      throw new ConflictException(`the lookup is already ${job.lookupStatus.toLowerCase()}`);
    }

    await this.prisma.aiJob.update({
      where: { jobId },
      data: {
        lookupStatus: LookupStatus.QUEUED,
        lookupError: null,
        lookupResult: Prisma.DbNull,
        lookupTimeMs: null,
        lookupStartedAt: null,
        lookupCompletedAt: null,
      },
    });

    await this.lookupQueue.add(RUN_LOOKUP_JOB, { jobId, requestedBy });
    await this.audit.log({
      eventType: 'ANALYZE_REQUEST',
      actorType: 'USER',
      actorLabel: requestedBy,
      jobId,
      endpoint: `/v1/jobs/${jobId}/lookup`,
      httpMethod: 'POST',
      statusCode: 202,
      extraData: { stage: 'splunk_lookup', requirements: requirements.length },
    });

    return {
      job_id: jobId,
      lookup_status: 'queued',
      requirements,
    };
  }

  async list(query: ListResultsQuery) {
    const where: Prisma.AiJobWhereInput = {};
    if (query.status_filter) {
      where.status = query.status_filter.toUpperCase() as JobStatus;
    }

    const [total, jobs] = await this.prisma.$transaction([
      this.prisma.aiJob.count({ where }),
      this.prisma.aiJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip ?? 0,
        take: query.limit ?? 50,
      }),
    ]);

    // Wrapped: Array.map passes the index as its second argument, which would
    // arrive as withEvidence and put the whole evidence blob in every row.
    return { total, items: jobs.map((job) => toJobResponse(job)) };
  }
}

/**
 * snake_case + lowercase status, matching what the dashboard and SOAR expect.
 *
 * `evidence` is left out of list responses: it holds every indicator and every
 * threat-intelligence record for a job, which is worth kilobytes per row and is
 * not what a list is for. The detail endpoints pass withEvidence.
 */
export function toJobResponse(job: AiJob, withEvidence = false) {
  return {
    job_id: job.jobId,
    alert_id: job.alertId,
    alert_name: job.alertName,
    raw_log: job.rawLog,
    status: job.status.toLowerCase(),
    ai_response: job.aiResponse,
    error_message: job.errorMessage,
    model_used: job.modelUsed,
    processing_time_ms: job.processingTimeMs,
    tokens_prompt: job.tokensPrompt,
    tokens_eval: job.tokensEval,
    created_at: job.createdAt,
    completed_at: job.completedAt,
    // Links this job to the agent run that produced the answer, so the trace —
    // which lookups were asked for and what came back — can be read beside it.
    agent_run_id: (job as { agentRunId?: string }).agentRunId ?? null,
    // What was established before the model ran. Kept apart from ai_response
    // because it is checkable: when the model's prose contradicts it, the two
    // disagree visibly instead of the prose being all anyone sees.
    // What stage 1 said it would want from Splunk, and where that stage got to.
    // On the list as well as the detail: a row whose lookup has not been run is
    // the one an analyst is deciding about, and that is decided from the list.
    splunk_requirements:
      ((job as { splunkRequirements?: unknown }).splunkRequirements as string[] | null) ?? [],
    lookup_status: ((job as { lookupStatus?: string }).lookupStatus ?? 'NOT_REQUESTED').toLowerCase(),
    lookup_error: (job as { lookupError?: string }).lookupError ?? null,
    lookup_time_ms: (job as { lookupTimeMs?: number }).lookupTimeMs ?? null,
    lookup_completed_at: (job as { lookupCompletedAt?: Date }).lookupCompletedAt ?? null,
    ...(withEvidence
      ? {
          evidence: (job as { evidence?: unknown }).evidence ?? null,
          // The answers themselves are only on the detail: each is a paragraph
          // of search output, which a list has no use for.
          // Still an array of answers, as it was before the analysis existed, so
          // nothing that reads it changes; jobs stored either way come out alike.
          lookup_result: splitLookup((job as { lookupResult?: unknown }).lookupResult).answers,
          final_analysis: finalAnalysisOf(job),
        }
      : {}),
  };
}

/**
 * The reading written after the searches, or null when there is none.
 *
 * A stored `running` is only true while the lookup is: the analysis is one of the
 * things a lookup does, so a lookup that is no longer queued or running, with the
 * analysis still marked running, is one a worker died in the middle of.
 */
function finalAnalysisOf(job: AiJob) {
  const analysis = splitLookup((job as { lookupResult?: unknown }).lookupResult).analysis;
  if (!analysis) return null;
  const working = job.lookupStatus === LookupStatus.QUEUED || job.lookupStatus === LookupStatus.RUNNING;
  if (analysis.status === 'running' && !working) {
    return { ...analysis, status: 'failed', error: 'the worker stopped before the analysis finished' };
  }
  return analysis;
}
