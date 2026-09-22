import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LookupStatus, Prisma } from '@prisma/client';
import { Job } from 'bullmq';

import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../audit/audit.service';
import { CatalogService } from '../enrichment/catalog.service';
import { SplunkService } from '../enrichment/splunk.service';
import {
  LOOKUP_QUEUE,
  LookupAnswer,
  SplunkLookupPayload,
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
 * Each one goes to the query agent on its own — that agent holds the schema and
 * turns a plain-language requirement into the right search, which is the split
 * the whole two-agent design exists for. They run one after another rather than
 * together: the model server loads one model at a time, so firing five at once
 * would queue inside Ollama instead of here, where the progress is visible.
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
    private readonly audit: AuditService,
    private readonly config: ConfigService,
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

    const agent = this.config.get<string>('lookup.agent');
    const answers: LookupAnswer[] = [];

    // Each answer is persisted as it arrives rather than all of them at the
    // end. Two reasons, both learned the hard way: a lookup is minutes per
    // requirement and a page showing nothing for ten minutes looks broken, and
    // when the worker died mid-run the answers it had already paid for died
    // with it.
    const save = async () => {
      await this.prisma.aiJob.update({
        where: { jobId },
        data: { lookupResult: answers as unknown as Prisma.InputJsonValue },
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
        // search. Running it through the query agent so it can emit those same
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
          result = await this.ai.generate(this.ask(plan), { agent });
        }

        answers.push({
          requirement: plan.requirement,
          answer: result.response,
          runId: result.run_id ?? null,
          durationMs: Date.now() - each,
          error: null,
          ranBy: planned ? 'backend' : 'agent',
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
          ranBy:
            plan.frequencyOf || plan.summarise || plan.filters || plan.fields?.length
              ? 'backend'
              : 'agent',
          ...where,
        });
      }
      await save();
    }

    const elapsedMs = Date.now() - startedAt;
    const failed = answers.filter((a) => a.error).length;

    await this.prisma.aiJob.update({
      where: { jobId },
      data: {
        // Every requirement failing is a failure; some failing is a result with
        // gaps, and the gaps are visible in the answers themselves.
        lookupStatus: failed === answers.length ? LookupStatus.FAILED : LookupStatus.COMPLETED,
        lookupResult: answers as unknown as Prisma.InputJsonValue,
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
      },
    });

    this.logger.log(
      `Lookup for ${jobId}: ${answers.length - failed}/${answers.length} answered in ${(elapsedMs / 1000).toFixed(1)}s`,
    );
  }

  /**
   * The requirement, plus where the catalogue says to look.
   *
   * The query agent still chooses the tool and builds the search — that is what
   * it knows how to do. What it no longer has to do is work out which of a
   * hundred field names carries a source IP in this sourcetype, because that
   * was resolved from the catalogue before any of this ran.
   */
  private ask(plan: PlannedLookup): string {
    const lines = [plan.requirement];
    const where: string[] = [];
    if (plan.index) where.push(`index ${plan.index}`);
    if (plan.sourcetype) where.push(`sourcetype ${plan.sourcetype}`);
    if (where.length > 0) lines.push('', `Look in ${where.join(', ')}.`);

    if (plan.fields?.length && plan.indicator) {
      lines.push(
        `In this data a ${plan.indicatorType} is carried by ${plan.fields.join(' or ')}. ` +
          `Search those for ${plan.indicator} — do not substitute a CIM name.`,
      );
    } else if (plan.indicatorType) {
      // Said out loud rather than left implicit: if this comes back empty, the
      // reason may be the field rather than the data.
      lines.push(
        '',
        `The catalogue names no field for a ${plan.indicatorType} here. Find one before ` +
          'concluding anything from an empty result.',
      );
    }
    return lines.join('\n');
  }
}
