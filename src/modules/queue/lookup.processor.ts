import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LookupStatus, Prisma } from '@prisma/client';
import { Job } from 'bullmq';

import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { buildConclusionPrompt, parseConclusion } from '../ai/conclusion';
import { AuditService } from '../audit/audit.service';
import { CatalogService } from '../enrichment/catalog.service';
import { SplunkService } from '../enrichment/splunk.service';
import {
  FinalAnalysis,
  LOOKUP_QUEUE,
  LookupAnswer,
  SplunkLookupPayload,
  StoredLookup,
} from './lookup-job.payload';

/** The shape stage 1 stored: a question plus where in Splunk to ask it. */
interface PlannedLookup {
  requirement: string;
  indicator?: string;
  indicatorType?: string;
  index?: string;
  sourcetype?: string;
  fields?: string[];
  /** A frequency check instead of an indicator pivot. */
  frequencyOf?: string;
  days?: number;
  earliest?: string;
  latest?: string;
  filters?: Record<string, string>;
  summarise?: {
    group_by?: string[];
    metrics: Array<{ fn: string; field?: string }>;
    span?: string;
    sort?: string;
  };
}

/**
 * Stage 2: run the requirements stage 1 wrote down.
 *
 * Each one already carries its plan — the indicator, the fields that hold it in
 * this estate, the index and sourcetype — resolved from the data catalogue before
 * any model ran, so each is sent straight to the Splunk connector. No model is
 * involved. They run one after another rather than together so the load on Splunk
 * stays small and the progress is visible.
 *
 * A requirement that has no plan is not searched. It used to be handed to a query
 * agent to work out; it is now kept, with the reason, for a person to run. Silently
 * doing nothing would read as "nothing found", which is the wrong answer.
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
    private readonly catalog: CatalogService,
    private readonly splunk: SplunkService,
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

    for (const [n, plan] of requirements.entries()) {
      const each = Date.now();
      this.logger.log(
        `Lookup for ${jobId}: ${n + 1}/${requirements.length} — ${plan.requirement.slice(0, 80)}`,
      );
      const where = { index: plan.index, sourcetype: plan.sourcetype, fields: plan.fields };

      // A question this data cannot answer is not worth minutes of inference.
      // When the catalogue is loaded and still names no field for this kind of
      // indicator, the estate does not record it — the test estate's FortiGate
      // logs carry IPs and no domain anywhere. Running it anyway meant falling
      // back to CIM names, searching four fields that do not exist, and getting
      // a confident "no related activity". The question is kept and the reason
      // is written in its place, so the gap is visible rather than answered.
      if (plan.indicatorType && !plan.fields?.length && this.catalog.loaded) {
        this.logger.warn(
          `Lookup for ${jobId}: skipping "${plan.requirement.slice(0, 60)}" — ` +
            `no field carries a ${plan.indicatorType} in ${plan.index ?? 'this estate'}`,
        );
        answers.push({
          requirement: plan.requirement,
          answer:
            `Not searched. The data catalogue names no field holding a ${plan.indicatorType} ` +
            `in ${[plan.index, plan.sourcetype].filter(Boolean).join('/') || 'this estate'}, ` +
            'so this cannot be answered from these logs. This is a gap in the catalogue or ' +
            'in what is collected — not evidence that nothing happened.',
          runId: null,
          durationMs: 0,
          error: null,
          ...where,
        });
        await save();
        continue;
      }

      try {
        // A plan with an indicator and the fields that carry it is already the
        // search. Handing it to a query agent so it could emit those same
        // parameters back as JSON measured 488s, of which Splunk used 0.409 —
        // the model contributed the transcription and nothing else.
        const planned = Boolean(
          plan.frequencyOf ||
            (plan.summarise && plan.index) ||
            (plan.filters && plan.index) ||
            (plan.indicator && plan.indicatorType && plan.fields?.length),
        );
        let result: { response: string; run_id?: string | null };
        let spl: string | undefined;
        let count: number | undefined;

        if (plan.frequencyOf) {
          const freq = await this.splunk.frequency(
            plan.frequencyOf, plan.days ?? 7, plan.earliest, plan.latest,
          );
          result = { response: this.splunk.renderFrequency(freq), run_id: null };
          spl = freq.spl;
          count = freq.total;
        } else if (plan.index && (plan.summarise || plan.filters)) {
          // Grouped, not listed. The filter is the indicator sitting in the
          // first field the catalogue gave for it — which is what makes this
          // a summary *of this alert* rather than of the whole index.
          const summary = await this.splunk.summarise({
            index: plan.index,
            sourcetype: plan.sourcetype,
            // The playbook's own filters when it gave any, otherwise the
            // indicator in the field the catalogue resolved for it.
            filters:
              plan.filters ??
              (plan.indicator && plan.fields?.length
                ? { [plan.fields[0]]: plan.indicator }
                : undefined),
            groupBy: plan.summarise?.group_by,
            // No metrics means the playbook asked for events, not a count.
            metrics: plan.summarise?.metrics ?? [{ fn: 'count' }],
            span: plan.summarise?.span,
            sort: plan.summarise?.sort,
            earliest: plan.earliest,
            latest: plan.latest,
          });
          result = { response: this.splunk.renderSummary(summary), run_id: null };
          spl = summary.spl;
          count = summary.count;
        } else if (planned) {
          const found = await this.splunk.search({
            indicator: plan.indicator!,
            indicatorType: plan.indicatorType!,
            fields: plan.fields!,
            index: plan.index,
            sourcetype: plan.sourcetype,
            earliest: plan.earliest,
            latest: plan.latest,
          });
          result = { response: this.splunk.render(found), run_id: null };
          spl = found.spl;
          count = found.count;
        } else {
          // Nothing here can be turned into a search: no indicator with a field
          // that carries it, no index to summarise, not a frequency check. Say so
          // instead of guessing — the requirement is kept, and so is the reason.
          answers.push({
            requirement: plan.requirement,
            answer:
              'Not searched. The backend could not turn this requirement into a search — ' +
              'it names no indicator the data catalogue has a field for, and no index to ' +
              'summarise. Run it in Splunk by hand. This is not evidence that nothing ' +
              'happened.',
            runId: null,
            durationMs: 0,
            error: null,
            ranBy: 'backend',
            ...where,
          });
          await save();
          continue;
        }

        answers.push({
          requirement: plan.requirement,
          answer: result.response,
          runId: result.run_id ?? null,
          durationMs: Date.now() - each,
          error: null,
          ranBy: 'backend',
          spl,
          count,
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
          ranBy: 'backend',
          ...where,
        });
      }
      await save();
    }

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
