import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { LookupStatus, Prisma } from '@prisma/client';
import { Job } from 'bullmq';

import { PrismaService } from '../../prisma/prisma.service';
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
}
