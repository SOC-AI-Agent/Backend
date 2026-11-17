import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobStatus, LookupStatus, Prisma } from '@prisma/client';
import { Job, Queue } from 'bullmq';

import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { buildRequirementsPrompt } from '../ai/conclusion';
import { ModelRequirement, parseRequirements, parseSuggestion } from '../ai/requirements';
import { CatalogService } from '../enrichment/catalog.service';
import { dropFields } from '../enrichment/drop-fields';
import { EnrichmentService } from '../enrichment/enrichment.service';
import { FieldProbeService } from '../enrichment/field-probe.service';
import { AuditService } from '../audit/audit.service';
import { ANALYSIS_QUEUE, AnalyzeAlertPayload } from './analysis-job.payload';
import { LOOKUP_QUEUE, RUN_LOOKUP_JOB, SplunkLookupPayload } from './lookup-job.payload';

/**
 * Runs only in the worker process (APP_ROLE=worker).
 *
 * Stage 1, and only stage 1: PROCESSING -> enrich -> the suggestion agent, then the
 * requirements agent (neither has tools; the second is skipped when
 * SPLUNK_LOOKUP_MODE=off) -> persist -> COMPLETED, writing an audit entry at every
 * transition. The AI service never touches the database.
 *
 * Searching Splunk is stage 2 and lives in its own queue. That is deliberate:
 * a lookup is minutes of inference per requirement, and on one worker it would
 * sit in front of every alert waiting to be triaged. processing_time_ms here
 * therefore means what an analyst waits for — the suggestion — and nothing
 * else.
 */
@Processor(ANALYSIS_QUEUE, {
  concurrency: Number.parseInt(process.env.WORKER_CONCURRENCY ?? '1', 10),
})
export class AnalysisProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalysisProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly enrichment: EnrichmentService,
    private readonly catalog: CatalogService,
    private readonly probe: FieldProbeService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    @InjectQueue(LOOKUP_QUEUE) private readonly lookupQueue: Queue<SplunkLookupPayload>,
  ) {
    super();
  }

  async process(job: Job<AnalyzeAlertPayload>): Promise<void> {
    const { jobId, alertId, alertName, useCaseId, rawLog, indicators, apiKeyId, actorLabel, ipAddress } =
      job.data;
    const startedAt = Date.now();

    const record = await this.prisma.aiJob.findUnique({ where: { jobId } });
    if (!record) {
      this.logger.warn(`Job ${jobId} no longer exists — skipping`);
      return;
    }

    // Extract the indicators and check them before the model runs. Both are
    // exact work with one right answer, so they are done here rather than left
    // for an agent to decide whether to bother with.
    // record.createdAt is when the alert reached us, which is the closest thing
    // to when it fired that is reliably present. Used to anchor the searches.
    const evidence = dropFields(rawLog, this.config.get<string[]>('enrichment.dropFields') ?? []);
    const splunkStage = this.config.get<string>('lookup.mode') !== 'off';
    const enrichment = await this.enrichment.run(
      evidence, indicators, alertName, undefined, record.createdAt, useCaseId,
    );
    const rendered = this.ai.buildRenderedPrompt(
      evidence,
      this.enrichment.render(enrichment, splunkStage),
    );

    await this.prisma.aiJob.update({
      where: { jobId },
      data: {
        status: JobStatus.PROCESSING,
        renderedPrompt: rendered,
        // Stored as its own column, not folded into the answer: this part is
        // checkable, and a summary that contradicts it should be visibly wrong.
        evidence: enrichment as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.log({
      eventType: 'JOB_PROCESSING',
      actorType: 'SYSTEM',
      actorLabel,
      jobId,
      extraData: { alert_id: alertId, alert_name: alertName },
    });

    // The suggestion. Without it there is nothing to show, so it is the one call
    // in this stage whose failure fails the job.
    let result: Awaited<ReturnType<AiService['generate']>>;
    try {
      result = await this.ai.generate(rendered, { agent: this.config.get<string>('ai.suggestAgent') });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.logger.error(`Job ${jobId} failed: ${message}`);

      await this.prisma.aiJob.update({
        where: { jobId },
        data: {
          status: JobStatus.FAILED,
          errorMessage: message,
          completedAt: new Date(),
        },
      });
      await this.audit.log({
        eventType: 'JOB_FAILED',
        actorType: 'SYSTEM',
        actorLabel,
        jobId,
        promptSnapshot: rendered,
        extraData: { error: message, alert_id: alertId },
      });
      return;
    }

    const suggestion = parseSuggestion(result.response);

    const { finalPlan, requirementsRun } = splunkStage
      ? await this.planLookups(jobId, rendered, suggestion.suggestion, enrichment)
      : { finalPlan: [], requirementsRun: null };
    const elapsedMs = Date.now() - startedAt;

    await this.prisma.aiJob.update({
      where: { jobId },
      data: {
        status: JobStatus.COMPLETED,
        aiResponse: suggestion.suggestion,
        splunkRequirements: finalPlan as unknown as Prisma.InputJsonValue,
        // The run behind the requirements is kept beside the evidence rather than
        // in a column of its own: it is a pointer for reading the trace, not
        // something the pipeline branches on.
        evidence: {
          ...enrichment,
          requirements_run_id: requirementsRun?.run_id ?? null,
        } as unknown as Prisma.InputJsonValue,
        modelUsed: result.model,
        processingTimeMs: elapsedMs,
        tokensPrompt: result.tokens_prompt + (requirementsRun?.tokens_prompt ?? 0),
        tokensEval: result.tokens_eval + (requirementsRun?.tokens_eval ?? 0),
        // The LLM server keeps the trace, not us — this is the only link back
        // to what the analysing agent asked the query agent for. Without it the
        // evidence page can show the inputs but not the reasoning in between.
        agentRunId: result.run_id ?? null,
        completedAt: new Date(),
      },
    });

    await this.audit.log({
      eventType: 'JOB_COMPLETED',
      actorType: apiKeyId ? 'API_KEY' : 'SYSTEM',
      actorId: apiKeyId,
      actorLabel,
      jobId,
      promptSnapshot: rendered,
      aiResponseSnapshot: result.response,
      ipAddress,
      durationMs: elapsedMs,
      extraData: {
        alert_id: alertId,
        alert_name: alertName,
        model: result.model,
        ai_service_ms: result.total_duration_ms + (requirementsRun?.total_duration_ms ?? 0),
        requirements: finalPlan.length,
      },
    });

    await this.maybeQueueLookup(jobId, finalPlan, actorLabel);
  }

  /**
   * What stage 2 would search: the requirements agent's questions, each aimed
   * by the catalogue, behind the playbook's own search.
   */
  private async planLookups(jobId: string, rendered: string, suggestion: string, enrichment: any) {
    // The requirements agent decides what is worth knowing; the catalogue decides where to
    // look. Each requirement it wrote names a value the extractor already
    // found, which gives the type without parsing English, and the type plus
    // the alert's own index and sourcetype give the fields. Nothing about the
    // search is guessed and nothing about the question is fixed in code.
    const maxRequirements = this.config.get<number>('lookup.maxRequirements');
    // Skipped values count as known here. They were skipped for ThreatQ — no
    // intel provider has heard of an internal address — but they are exactly
    // what a Splunk search is for, and the model asks about them constantly:
    // "what else did 10.1.100.44 talk to" is the right question and used to
    // come back unaimable.
    const known = [
      ...enrichment.indicators.map((i) => ({ type: i.type, value: i.value, source: i.source })),
      ...enrichment.skipped
        // Jobs from before `searchable` existed: anything typed but a placeholder.
        .filter((s: any) => s.type && (s.searchable ?? s.reason !== 'placeholder value, not an indicator'))
        .map((s: any) => ({
          type: s.type,
          value: s.value,
          source: 'skipped for intel, still searchable',
        })),
    ];

    // A second call, to a second agent, that reads the suggestion as well as the
    // alert. Its failure costs the model-chosen part of the plan, not the job: the
    // suggestion is already in hand and the derived plan below is the floor.
    let requirementsRun: Awaited<ReturnType<AiService['generate']>> | null = null;
    let asked: ReturnType<AnalysisProcessor['aim']> = [];
    try {
      requirementsRun = await this.ai.generate(
        buildRequirementsPrompt(rendered, suggestion, maxRequirements),
        { agent: this.config.get<string>('ai.requirementsAgent') },
      );
      // A detail the agent lists is kept only if it appears in what the agent was
      // shown: the alert, ThreatQ, the playbook and the suggestion.
      const shown = `${rendered}\n${suggestion}`;
      asked = this.aim(
        parseRequirements(requirementsRun.response, known, maxRequirements, shown),
        enrichment,
      );
    } catch (err: any) {
      this.logger.warn(
        `Job ${jobId}: the requirements agent failed (${err?.message ?? err}) — ` +
          'the suggestion is kept and the derived plan is used instead',
      );
    }

    // No usable question from the model is not the same as no question. The
    // derived plan — what follows mechanically from the indicators — is the
    // floor, so a bad generation costs quality rather than the whole stage.
    // What the model asked for, or — when it asked for nothing usable — what
    // follows mechanically from the indicators. A bad generation should cost
    // quality, not the whole stage.
    const body = asked.length > 0 ? asked : enrichment.lookups.filter((l: any) => l.scope !== 'playbook');
    if (asked.length === 0 && body.length > 0) {
      this.logger.warn(
        `Job ${jobId}: the model asked for nothing that could be aimed — ` +
          `falling back to ${body.length} derived lookup(s)`,
      );
    }

    // The playbook's own search goes first, whatever the model asked for. A
    // person who knew both this detection and this estate wrote it, so it does
    // not depend on the model remembering to want it — and it carries
    // structure (index, filters, metrics) that a requirement copied out as a
    // sentence would lose. Added after the fallback is decided, or its
    // presence would make an empty model reply look like a full plan.
    const fromPlaybook = enrichment.lookups.filter((l: any) => l.scope === 'playbook');
    const finalPlan = [...fromPlaybook, ...body].slice(0, maxRequirements);

    // What the catalogue could not place, Splunk is asked about: one small search
    // per sourcetype and type, cached, capped per job.
    const probed = await this.probe.aimUnaimed(jobId, finalPlan, enrichment.source ?? {});
    if (probed > 0) this.logger.log(`Job ${jobId}: ${probed} lookup(s) aimed by probing Splunk`);

    const unaimed = finalPlan.filter((l: any) => l.indicatorType && l.unscoped);
    if (unaimed.length > 0) {
      this.logger.warn(
        `Job ${jobId}: ${unaimed.length} of ${finalPlan.length} lookups are not aimed at a field — ` +
          `the catalogue has no entry for: ${[...new Set(unaimed.map((l: any) => l.indicatorType))].join(', ')}`,
      );
    }

    return { finalPlan, requirementsRun };
  }

  /**
   * Give each of the model's requirements somewhere to look.
   *
   * The question is the model's, unchanged — it is what the analyst reads and
   * approves. Everything after the question mark is the catalogue's: which
   * index, which sourcetype, which field names carry this kind of value here.
   */
  private aim(requirements: ModelRequirement[], enrichment: any) {
    const source = enrichment.source;
    const window = this.window(enrichment.alertTime ?? new Date());
    const aimed = requirements.map((r) => {
      // The details the agent listed under the question, and which field each
      // one sits in here, when the catalogue knows. Both go to Text-to-SPL with
      // the question.
      const details = {
        ...(r.context ? { context: r.context } : {}),
        ...(r.droppedContext ? { droppedContext: r.droppedContext } : {}),
      };
      if (!r.indicator || !r.indicatorType) {
        // Kept rather than dropped. A requirement naming nothing we extracted
        // is either about something outside the alert or invented, and an
        // analyst should see which rather than watch it disappear. Still sent
        // with the alert's window, its details and where the alert came from.
        const fieldHints = this.fieldHints(r, [], source?.index, source?.sourcetype);
        return {
          requirement: r.requirement,
          because: r.unmatched,
          rank: 9,
          unscoped: true,
          alertIndex: source?.index,
          alertSourcetype: source?.sourcetype,
          ...details,
          ...(fieldHints.length ? { fieldHints } : {}),
          ...window,
        };
      }
      const where = this.catalog.resolveIndicator(
        r.indicatorType, source?.index, source?.sourcetype,
      );
      const fieldHints = this.fieldHints(
        r, where.fields, where.index ?? source?.index, where.sourcetype ?? source?.sourcetype,
      );
      return {
        requirement: r.requirement,
        because: `${r.indicatorType} ${r.indicator}, asked for by the model`,
        rank: 1,
        indicator: r.indicator,
        indicatorType: r.indicatorType,
        index: where.index,
        sourcetype: where.sourcetype,
        alertIndex: source?.index,
        alertSourcetype: source?.sourcetype,
        scope: where.scope,
        fields: where.fields,
        unscoped: where.fields.length === 0,
        ...(where.via ? { aimedBy: where.via } : {}),
        ...details,
        ...(fieldHints.length ? { fieldHints } : {}),
        ...window,
      };
    });

    // Drop duplicate questions that resolve to the exact same search target
    // (same index, sourcetype, indicator, and fieldHints), unless one is an
    // aggregate ("how many", "count", "top") and the other is an event list.
    const seenSearch = new Set<string>();
    return aimed.filter((item) => {
      if (!('indicator' in item) || !item.indicator || item.unscoped) return true;
      const isAgg = /\b(how many|count|top|most|frequen|which (?:hosts?|address|destinations?|ports?)|talk(?:ed|ing)? to|connect(?:ed|ions?)? to|destinations?|distinct)\b/i.test(
        item.requirement,
      );
      const hintsSig = (item.fieldHints ?? [])
        .map((h) => `${h.value}:${h.fields.join(',')}`)
        .sort()
        .join(';');
      const sig = `${item.index ?? ''}|${item.sourcetype ?? ''}|${item.indicator}|${hintsSig}|${isAgg ? 'agg' : 'list'}`;
      if (seenSearch.has(sig)) return false;
      seenSearch.add(sig);
      return true;
    });
  }

  /**
   * Which field each value sits in, for Text-to-SPL: the indicator in the fields
   * the catalogue resolved for it, and each detail whose key names a meaning the
   * catalogue maps (`user`, `device`, `source`, ...). This is the part Text-to-SPL
   * cannot know on its own — `srcip` here, not the CIM `src_ip`.
   */
  private fieldHints(
    r: ModelRequirement,
    indicatorFields: string[],
    index?: string,
    sourcetype?: string,
  ): Array<{ value: string; fields: string[] }> {
    const hints: Array<{ value: string; fields: string[] }> = [];
    if (r.indicator && indicatorFields.length) {
      hints.push({ value: r.indicator, fields: indicatorFields });
      // When the primary indicator is already placed in its resolved field(s),
      // only add `device`/`host` context if the search is scoped to a single
      // sourcetype AND the indicator itself is not already a host. Adding every
      // other indicator (`user` + `source` + `device` all ANDed together) turns
      // a pivot search ("what else did IP X or user Y do?") into an intersection
      // that only matches the original alert event itself, or 0 rows when
      // widening across sourcetypes.
      if (sourcetype && r.indicatorType !== 'host') {
        for (const [key, value] of Object.entries(r.context ?? {})) {
          if (!['device', 'host', 'hostname'].includes(key)) continue;
          if (hints.some((h) => h.value === value)) continue;
          const fields = this.catalog.fieldsForDetail(key, value, index, sourcetype);
          if (fields.length) hints.push({ value, fields });
        }
      }
      return hints;
    }
    for (const [key, value] of Object.entries(r.context ?? {})) {
      if (hints.some((h) => h.value === value)) continue;
      const fields = this.catalog.fieldsForDetail(key, value, index, sourcetype);
      if (fields.length) hints.push({ value, fields });
    }
    return hints;
  }

  /** The window every search is anchored to: around the alert, not around now. */
  private window(alertTime: Date) {
    const ms = 3_600_000;
    return {
      earliest: new Date(alertTime.getTime() - 24 * ms).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      latest: new Date(alertTime.getTime() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  }

  /**
   * Hand stage 2 on, or leave it for a person.
   *
   * `manual` is the default because each requirement is a full agent run, and
   * on CPU-only inference that is minutes. Spending it should be someone's
   * decision about a particular alert, not something every alert does on the
   * way past.
   */
  private async maybeQueueLookup(
    jobId: string,
    requirements: unknown[],
    actorLabel?: string | null,
  ): Promise<void> {
    if (requirements.length === 0) return;

    if (this.config.get<string>('lookup.mode') !== 'auto') {
      this.logger.log(
        `Job ${jobId}: ${requirements.length} requirement(s) stored, waiting to be asked ` +
          '(SPLUNK_LOOKUP_MODE=manual)',
      );
      return;
    }

    await this.prisma.aiJob.update({
      where: { jobId },
      data: { lookupStatus: LookupStatus.QUEUED },
    });
    await this.lookupQueue.add(RUN_LOOKUP_JOB, { jobId, requestedBy: actorLabel ?? 'auto' });
    this.logger.log(`Job ${jobId}: queued ${requirements.length} Splunk requirement(s)`);
  }
}
