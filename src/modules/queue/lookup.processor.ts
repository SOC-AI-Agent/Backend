import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LookupStatus, Prisma } from '@prisma/client';
import { Job } from 'bullmq';

import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { buildConclusionPrompt, parseConclusion } from '../ai/conclusion';
import { AuditService } from '../audit/audit.service';
import {
  SplunkAnswer,
  SplunkLookupError,
  SplunkMcpService,
  SplunkSession,
} from '../enrichment/splunk-mcp.service';
import {
  FinalAnalysis,
  LOOKUP_QUEUE,
  LookupAnswer,
  SplunkLookupPayload,
  StoredLookup,
} from './lookup-job.payload';

/** The shape stage 1 stored: a question, the alert's details for it, and where in Splunk to ask it. */
interface PlannedLookup {
  requirement: string;
  indicator?: string;
  indicatorType?: string;
  index?: string;
  sourcetype?: string;
  alertIndex?: string;
  alertSourcetype?: string;
  fields?: string[];
  context?: Record<string, string>;
  fieldHints?: Array<{ value: string; fields: string[] }>;
  filters?: Record<string, string>;
  summarise?: { group_by?: string[]; metrics: Array<{ fn: string; field?: string }>; span?: string; sort?: string };
  frequencyOf?: string;
  earliest?: string;
  latest?: string;
}

/**
 * Stage 2: ask Splunk the requirements stage 1 wrote down.
 *
 * Each requirement goes to the Splunk connector (MCP-Server/Splunk) over MCP, as
 * stage 1 stored it: the question, the details the requirements agent listed from
 * the alert (device, source, user, ...), the index, sourcetype and field names the
 * catalogue resolved, and the window. The connector turns that into a prompt, has
 * Text-to-SPL write the search, checks it is read-only and inside the allowed
 * indexes, runs it, and hands back the SPL and the rows (`splunk_lookup`). With
 * LLM_SPL_AGENT set, that agent writes the SPL from the connector's writer prompt
 * (`splunk_prompt`) and the connector checks and runs it the same way; a draft
 * that fails falls back to the connector's own. They run one after another so the load on Splunk stays small and
 * the progress is visible.
 *
 * Then, once the searches are in, a third agent reads them beside the suggestion
 * and writes the second reading (see FinalAnalysis). It has no tools, its failure
 * does not fail the lookup — the answers are already saved and are worth having on
 * their own — and the lookup stays RUNNING until it finishes, so a worker that dies
 * mid-analysis is cleaned up by the same recovery as one that dies mid-search.
 *
 * A requirement that fails does not fail the lookup. Four answers and one error
 * is more use to an analyst than nothing at all, and the error is kept beside
 * the others rather than thrown away.
 */
@Processor(LOOKUP_QUEUE, {
  concurrency: Number.parseInt(process.env.LOOKUP_CONCURRENCY ?? '1', 10),
})
export class LookupProcessor extends WorkerHost {
  private readonly logger = new Logger(LookupProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly splunk: SplunkMcpService,
  ) {
    super();
  }

  async process(job: Job<SplunkLookupPayload>): Promise<void> {
    const { jobId, requestedBy } = job.data;
    const startedAt = Date.now();

    const record = await this.prisma.aiJob.findUnique({ where: { jobId } });
    if (!record) {
      this.logger.warn(`Lookup for ${jobId}: the job no longer exists — skipping`);
      return;
    }

    const requirements = (record.splunkRequirements ?? []) as unknown as PlannedLookup[];
    if (!Array.isArray(requirements) || requirements.length === 0) {
      await this.prisma.aiJob.update({
        where: { jobId },
        data: {
          lookupStatus: LookupStatus.FAILED,
          lookupError: 'nothing was stored to look up',
          lookupCompletedAt: new Date(),
        },
      });
      return;
    }

    await this.prisma.aiJob.update({
      where: { jobId },
      data: { lookupStatus: LookupStatus.RUNNING, lookupStartedAt: new Date(), lookupError: null },
    });
    await this.audit.log({
      eventType: 'JOB_PROCESSING',
      actorType: requestedBy === 'auto' ? 'SYSTEM' : 'USER',
      actorLabel: requestedBy,
      jobId,
      extraData: { stage: 'splunk_lookup', requirements: requirements.length },
    });

    const answers: LookupAnswer[] = [];

    // Each answer is persisted as it arrives rather than all of them at the
    // end. Two reasons, both learned the hard way: a lookup is minutes per
    // requirement and a page showing nothing for ten minutes looks broken, and
    // when the worker died mid-run the answers it had already paid for died
    // with it.
    let analysis: FinalAnalysis | undefined;
    const stored = (): StoredLookup => ({ answers, ...(analysis ? { analysis } : {}) });
    const save = async () => {
      await this.prisma.aiJob.update({
        where: { jobId },
        data: { lookupResult: stored() as unknown as Prisma.InputJsonValue },
      });
    };

    // One MCP session for the whole lookup. If Splunk cannot be reached, every
    // requirement is still written down, each with the reason, rather than the
    // lookup failing with nothing to show.
    let session: SplunkSession | undefined;
    let connectError = '';
    try {
      session = await this.splunk.connect();
    } catch (err: any) {
      connectError = err?.message ?? String(err);
      this.logger.error(`Lookup for ${jobId}: ${connectError}`);
    }

    // The SPL agent drafts every search up front and at once: they are short calls
    // that do not touch Splunk, so only the searches themselves queue up below.
    const drafts = await this.draftAll(jobId, session, requirements);

    for (const [n, plan] of requirements.entries()) {
      const each = Date.now();
      this.logger.log(
        `Lookup for ${jobId}: ${n + 1}/${requirements.length} — ${plan.requirement.slice(0, 80)}`,
      );
      const where = { index: plan.index, sourcetype: plan.sourcetype, fields: plan.fields };

      try {
        if (!session) throw new Error(connectError);
        const draft = drafts[n];
        let asked: SplunkAnswer | undefined;
        let draftError = draft?.error;
        if (draft?.reply) {
          try {
            asked = await session.ask(plan, draft.reply);
          } catch (err: any) {
            // No SPL in the reply, refused by the guard, or rejected by Splunk: the
            // connector's own search is the floor, so a bad draft costs one retry.
            draftError = err?.message ?? String(err);
            this.logger.warn(
              `Lookup for ${jobId}: the SPL agent's search for "${plan.requirement.slice(0, 60)}" ` +
                `was dropped (${draftError}) — the connector writes it instead`,
            );
          }
        }
        const byAgent = asked !== undefined;
        asked ??= await session.ask(plan);
        answers.push({
          requirement: plan.requirement,
          answer: asked.answer,
          runId: byAgent ? draft?.runId ?? null : null,
          durationMs: Date.now() - each + (draft?.durationMs ?? 0),
          error: null,
          ranBy: 'splunk',
          writtenBy: byAgent ? 'agent' : asked.writtenBy,
          ...(!byAgent && draftError ? { draftError } : {}),
          prompt: asked.prompt,
          spl: asked.spl,
          count: asked.count,
          ...where,
        });
      } catch (err: any) {
        const message = err?.message ?? String(err);
        this.logger.error(
          `Lookup for ${jobId}: "${plan.requirement.slice(0, 60)}" failed: ${message}`,
        );
        answers.push({
          requirement: plan.requirement,
          answer: '',
          runId: null,
          durationMs: Date.now() - each,
          error: message,
          ranBy: 'splunk',
          // The connector builds the prompt; it says what it had when it got that far.
          ...(err instanceof SplunkLookupError && err.prompt ? { prompt: err.prompt } : {}),
          ...(err instanceof SplunkLookupError && err.spl ? { spl: err.spl } : {}),
          ...where,
        });
      }
      await save();
    }
    await session?.close().catch(() => undefined);

    const searchMs = Date.now() - startedAt;
    const failed = answers.filter((a) => a.error).length;

    // Third agent, after the searches. Skipped, with the reason written down, when
    // nothing was searched: an analysis with no results would only restate the
    // suggestion, and one that hears only about gaps has nothing to add.
    if (this.config.get<boolean>('lookup.analyse')) {
      const searched = answers.filter((a) => !a.error && a.spl);
      if (searched.length === 0) {
        analysis = {
          status: 'skipped',
          reason:
            'No search ran, so there is nothing new to analyse. Every requirement was either ' +
            'not searched or failed — see the answers above.',
        };
      } else if (!record.aiResponse || !record.renderedPrompt) {
        analysis = { status: 'skipped', reason: 'The first reading was not stored, so there is nothing to compare against.' };
      } else {
        analysis = {
          status: 'running',
          startedAt: new Date().toISOString(),
          resultsUsed: answers.length,
        };
        await save();
        analysis = await this.conclude(jobId, record.renderedPrompt, record.aiResponse, answers, analysis);
      }
    }

    const elapsedMs = Date.now() - startedAt;

    await this.prisma.aiJob.update({
      where: { jobId },
      data: {
        // Every requirement failing is a failure; some failing is a result with
        // gaps, and the gaps are visible in the answers themselves. The analysis
        // failing is neither: the searches worked.
        lookupStatus: failed === answers.length ? LookupStatus.FAILED : LookupStatus.COMPLETED,
        lookupResult: stored() as unknown as Prisma.InputJsonValue,
        lookupError: failed === answers.length ? answers[0]?.error ?? 'every requirement failed' : null,
        lookupTimeMs: elapsedMs,
        lookupCompletedAt: new Date(),
      },
    });

    await this.audit.log({
      eventType: failed === answers.length ? 'JOB_FAILED' : 'JOB_COMPLETED',
      actorType: requestedBy === 'auto' ? 'SYSTEM' : 'USER',
      actorLabel: requestedBy,
      jobId,
      durationMs: elapsedMs,
      extraData: {
        stage: 'splunk_lookup',
        answered: answers.length - failed,
        failed,
        analysis: analysis?.status ?? 'off',
        search_ms: searchMs,
      },
    });

    this.logger.log(
      `Lookup for ${jobId}: ${answers.length - failed}/${answers.length} answered in ` +
        `${(searchMs / 1000).toFixed(1)}s` +
        (analysis ? `, analysis ${analysis.status} (${((elapsedMs - searchMs) / 1000).toFixed(1)}s)` : ''),
    );
  }

  /**
   * The SPL agent's reply for each requirement, in order; undefined where it was
   * not asked. Never throws — a requirement without a draft is written by the
   * connector, as all of them are when LLM_SPL_AGENT is unset.
   *
   * Not asked: a playbook's own search (filters, summarise) and the alert-frequency
   * count. Those arrive as structure the connector's template turns into SPL
   * exactly; a model can only match that or get it wrong.
   */
  private async draftAll(
    jobId: string,
    session: SplunkSession | undefined,
    plans: PlannedLookup[],
  ): Promise<Array<{ reply?: string; runId?: string | null; error?: string; durationMs: number } | undefined>> {
    const agent = this.config.get<string>('ai.splAgent');
    if (!agent || !session) return plans.map(() => undefined);

    return Promise.all(
      plans.map(async (plan) => {
        if (plan.filters || plan.summarise || plan.frequencyOf) return undefined;
        const began = Date.now();
        try {
          const prompt = await session.writerPrompt(plan);
          if (!prompt) return undefined;
          const run = await this.ai.generate(prompt, { agent });
          return { reply: run.response, runId: run.run_id ?? null, durationMs: Date.now() - began };
        } catch (err: any) {
          const error = err?.message ?? String(err);
          this.logger.warn(
            `Lookup for ${jobId}: the SPL agent failed for "${plan.requirement.slice(0, 60)}" ` +
              `(${error}) — the connector writes it instead`,
          );
          return { error, durationMs: Date.now() - began };
        }
      }),
    );
  }

  /**
   * The second reading: the alert, the first reading and the numbered results, to
   * an agent with no tools. Never throws — a failed analysis is recorded on the
   * job, next to the answers it could not read.
   */
  private async conclude(
    jobId: string,
    rendered: string,
    suggestion: string,
    answers: LookupAnswer[],
    running: FinalAnalysis,
  ): Promise<FinalAnalysis> {
    const began = Date.now();
    const done = () => ({ durationMs: Date.now() - began, completedAt: new Date().toISOString() });

    try {
      const run = await this.ai.generate(buildConclusionPrompt(rendered, suggestion, answers), {
        agent: this.config.get<string>('ai.concludeAgent'),
      });
      const text = parseConclusion(run.response);
      if (!text) {
        return { ...running, ...done(), status: 'failed', error: 'the agent returned nothing' };
      }
      return { ...running, ...done(), status: 'completed', text, model: run.model, runId: run.run_id ?? null };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.logger.warn(`Lookup for ${jobId}: the analysis failed — the answers are kept: ${message}`);
      return { ...running, ...done(), status: 'failed', error: message };
    }
  }
}
