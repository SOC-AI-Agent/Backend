import { Injectable, Logger } from '@nestjs/common';

import { Indicator, IocService } from './ioc.service';
import { PlaybookMatch, PlaybookService } from './playbook.service';
import { QueryPlanService, SuggestedLookup } from './query-plan.service';
import { SourceHint, SourceMapService } from './source-map.service';
import { ThreatQResult, ThreatQService } from './threatq.service';

export interface Enrichment {
  indicators: Indicator[];
  skipped: Array<{ value: string; reason: string }>;
  threatq: ThreatQResult;
  source: SourceHint | null;
  lookups: SuggestedLookup[];
  /**
   * The anchor every search uses: when the alert fired, not when a search runs.
   * Carried on the result so anything planning a lookup later — including a
   * button pressed the next morning — uses the same one.
   */
  alertTime: Date;
  /**
   * What the runbook says about this detection, when one covers it.
   *
   * The part of triage the log cannot supply: what makes this a true positive
   * and what makes it noise. Without it a suggestion can say what happened and
   * not whether it matters.
   */
  playbook: PlaybookMatch | null;
}

/**
 * Everything worth knowing before the model sees the alert.
 *
 * Runs in the worker, deterministically, so the agent starts with the
 * indicators already extracted and already checked. That leaves it one
 * decision to make — whether the alert needs log data — instead of four.
 */
@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);

  constructor(
    private readonly ioc: IocService,
    private readonly threatq: ThreatQService,
    private readonly sourceMap: SourceMapService,
    private readonly queryPlan: QueryPlanService,
    private readonly playbook: PlaybookService,
  ) {}

  async run(
    rawLog: string,
    supplied?: Array<{ type: string; value: string; source?: string }>,
    alertName = '',
    alertFields?: Record<string, unknown>,
    // When the alert fired, not when this runs. The searches are anchored to
    // it, so pressing the button a day later still looks where the alert is.
    alertTime: Date = new Date(),
  ): Promise<Enrichment> {
    const resolvedTime = this.parseLogTime(rawLog) ?? alertTime;
    const { indicators: fromSoar } = this.ioc.normalise(supplied);
    const { indicators, skipped } = this.ioc.extract(rawLog, fromSoar);
    const threatq = await this.threatq.lookup(indicators);
    const source = this.sourceMap.resolve(alertName, rawLog, alertFields);
    // Asked in parallel with nothing, because it is one HTTP call and the
    // model cannot start until the whole block is ready anyway.
    const playbook = await this.playbook.match(alertName);
    const searchableSkipped = skipped
      .filter(
        (s) =>
          s.reason === 'private or non-routable address' ||
          s.reason.startsWith('listed as internal') ||
          s.reason === 'local endpoint artifact' ||
          s.reason === 'relative URI path',
      )
      .map((s) => ({ type: s.type, value: s.value, source: 'internal' }));
    const lookups = this.queryPlan.build(
      [...indicators, ...searchableSkipped], source, alertName, rawLog, resolvedTime, playbook,
    );
    this.logger.log(
      `extracted ${indicators.length} indicators (${skipped.length} skipped), ` +
        `ThreatQ ${threatq.available ? `checked ${threatq.checked}, ${threatq.hits.length} hits` : 'unavailable'}, `
        + `${lookups.length} lookups suggested`,
    );
    return { indicators, skipped, threatq, source, lookups, alertTime: resolvedTime, playbook };
  }

  /**
   * Read the event's own timestamp out of the raw log when present (ISO 8601 /
   * Sysmon SystemTime, Apache CLF, or Windows Event Log header), so historical
   * or replayed alerts search around when the event happened rather than now.
   */
  private parseLogTime(rawLog: string): Date | null {
    // 1. ISO 8601 (e.g. Sysmon SystemTime='2024-12-24T17:01:41.1280062Z')
    const iso = rawLog.match(
      /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/,
    );
    if (iso) {
      const d = new Date(iso[1].replace(/\.(\d{3})\d*/, '.$1'));
      if (!Number.isNaN(d.getTime())) return d;
    }

    // 2. Apache / NCSA Combined Log Format: [24/Dec/2024:08:47:37 -0800]
    const clf = rawLog.match(
      /\[(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}:\d{2}:\d{2})\s+([+-]\d{2})(\d{2})\]/,
    );
    if (clf) {
      const months: Record<string, string> = {
        jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
        jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
      };
      const mon = months[clf[2].toLowerCase()];
      if (mon) {
        const d = new Date(`${clf[3]}-${mon}-${clf[1]}T${clf[4]}${clf[5]}:${clf[6]}`);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }

    // 3. Windows Event Log header: 12/24/2024 09:04:26 AM (lab TZ: UTC-8)
    const win = rawLog.match(
      /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([AP]M)\b/i,
    );
    if (win) {
      const mm = win[1].padStart(2, '0');
      const dd = win[2].padStart(2, '0');
      let hh = Number.parseInt(win[4], 10);
      const ampm = win[7].toUpperCase();
      if (ampm === 'PM' && hh < 12) hh += 12;
      if (ampm === 'AM' && hh === 12) hh = 0;
      const d = new Date(`${win[3]}-${mm}-${dd}T${String(hh).padStart(2, '0')}:${win[5]}:${win[6]}-08:00`);
      if (!Number.isNaN(d.getTime())) return d;
    }

    return null;
  }

  /**
   * The enrichment as the model should read it.
   *
   * Written as facts with their source attached, and explicit about what was
   * NOT established — "no threat-intelligence record" is a different statement
   * from "clean", and a model given the short version will print the wrong one.
   */
  render(enrichment: Enrichment, forSearch = true): string {
    const lines: string[] = [];
    const { indicators, skipped, threatq } = enrichment;

    // First, because it defines what a true positive is here. The rest is
    // evidence to be read against that, and evidence read without a
    // definition is where a model starts inventing one.
    const playbook = this.playbook.render(enrichment.playbook);
    if (playbook) lines.push(playbook, '');
    // Where the alert's data lives only matters to something that will search it.
    if (forSearch) lines.push(this.sourceMap.render(enrichment.source), '');
    lines.push('--- EXTRACTED INDICATORS ---');
    if (indicators.length === 0) {
      lines.push('(none found in the alert)');
    } else {
      for (const i of indicators) {
        lines.push(`${i.type}: ${i.value}  (from ${i.source})`);
      }
    }
    if (skipped.length > 0) {
      lines.push(
        `Not looked up: ${skipped.map((s) => `${s.value} (${s.reason})`).join('; ')}`,
      );
    }

    lines.push('', '--- THREAT INTELLIGENCE (ThreatQ) ---');
    if (!threatq.available) {
      lines.push(
        `NOT CHECKED — ${threatq.error ?? 'lookup unavailable'}.`,
        'Treat every indicator above as UNKNOWN. Do not describe anything as clean.',
      );
    } else if (threatq.hits.length === 0) {
      lines.push(
        `${threatq.checked} indicator(s) checked, no records found.`,
        'No record means ThreatQ has not seen it. That is UNKNOWN, not safe —',
        'threat intelligence trails an attacker, and new infrastructure has no record yet.',
      );
    } else {
      for (const hit of threatq.hits) {
        const detail = [
          hit.score !== undefined ? `score ${hit.score}` : null,
          hit.status ? `status ${hit.status}` : null,
          hit.sources?.length ? `${hit.sources.length} source(s): ${hit.sources.join(', ')}` : null,
          hit.adversaries?.length ? `adversary ${hit.adversaries.join(', ')}` : null,
          hit.first_seen ? `first seen ${hit.first_seen}` : null,
        ]
          .filter(Boolean)
          .join(', ');
        lines.push(`${hit.value} — ${detail}`);
      }
      const clean = threatq.checked - threatq.hits.length;
      if (clean > 0) {
        lines.push(`${clean} other indicator(s) checked with no record — unknown, not safe.`);
      }
    }
    if (threatq.available && threatq.failed) {
      lines.push(
        `${threatq.failed} more indicator(s) NOT CHECKED — ${threatq.error}. Treat them as UNKNOWN.`,
      );
    }
    // The derived lookups are deliberately NOT shown here any more.
    //
    // They used to be, when an agent held ask_splunk and had to pick from
    // something. Now the model is asked what it wants and the backend runs it,
    // and a list in the prompt turns that into a copying exercise — observed
    // exactly: the reply came back quoting one of these lines verbatim, which
    // then named no indicator and could not be aimed. The plan still exists as
    // the fallback for a reply that asks for nothing usable.

    return lines.join('\n');
  }
}
