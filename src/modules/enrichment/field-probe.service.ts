import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SplunkMcpService, SplunkSession } from './splunk-mcp.service';

/**
 * The last way to aim a search: ask Splunk which field the value is in.
 *
 * After the catalogue's role and the common field names, a value can still have
 * nowhere to go — a sourcetype nobody described, a type the catalogue never
 * mapped there. Rather than send it as a bare term, this runs one small search
 * for the value in the alert's own index and sourcetype, around the alert, and
 * reads off the fields whose value is exactly it. That is the field the
 * requirement's search is then aimed at.
 *
 * What is learned is about the sourcetype, not the value: once `file` is where
 * filenames sit in access_combined, the next filename there needs no probe. So
 * the answer is cached by index, sourcetype and type, and a job spends at most
 * SPLUNK_FIELD_PROBE_MAX searches on it. Read-only like every other search: it
 * goes through the connector's splunk_run_query, which checks it.
 */

/** Fields that say where an event is stored, not what is in it. */
const NOT_CONTENT = new Set([
  'index', 'source', 'sourcetype', 'splunk_server', 'splunk_server_group', 'linecount', 'punct',
  'eventtype', 'tag', 'timestartpos', 'timeendpos',
]);

interface Cached {
  fields: string[];
  until: number;
}

export interface ProbeScope {
  index: string;
  sourcetype?: string;
  earliest?: string;
  latest?: string;
}

@Injectable()
export class FieldProbeService {
  private readonly logger = new Logger(FieldProbeService.name);
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly config: ConfigService,
    private readonly splunk: SplunkMcpService,
  ) {}

  get enabled(): boolean {
    return this.config.get<boolean>('lookup.fieldProbe') === true;
  }

  /**
   * Aim every plan item the catalogue could not, in place. Returns how many were
   * aimed. Never throws: a probe that fails leaves the item as it was — searched
   * as a quoted term — which is where it would have been without this.
   */
  async aimUnaimed(jobId: string, plan: any[], alert: { index?: string; sourcetype?: string }): Promise<number> {
    if (!this.enabled) return 0;
    const todo = plan.filter(
      (p) => p.indicator && p.indicatorType && p.unscoped && !p.filters && !p.summarise && !p.frequencyOf,
    );
    if (todo.length === 0) return 0;

    let budget = this.config.get<number>('lookup.maxProbes') ?? 3;
    let session: SplunkSession | undefined;
    let aimed = 0;
    try {
      for (const item of todo) {
        const index = item.index ?? item.alertIndex ?? alert.index;
        const sourcetype = item.sourcetype ?? item.alertSourcetype ?? alert.sourcetype;
        // No index, no probe: an estate-wide search for a value is the expensive
        // kind of search this is meant to avoid.
        if (!index) continue;
        const key = `${index}|${sourcetype ?? ''}|${item.indicatorType}`;
        let fields = this.cached(key);
        if (fields === undefined) {
          if (budget <= 0) continue;
          budget -= 1;
          session ??= await this.splunk.connect();
          fields = await this.probe(session, item.indicator, { index, sourcetype, earliest: item.earliest, latest: item.latest });
          if (fields === null) break; // the connector cannot run a search: no point trying the rest
          this.remember(key, fields);
        }
        if (fields.length === 0) continue;
        item.fields = fields;
        item.index = index;
        item.sourcetype = sourcetype;
        item.scope = sourcetype ? 'sourcetype' : 'index';
        item.unscoped = false;
        item.aimedBy = 'probe';
        if (Array.isArray(item.fieldHints) && !item.fieldHints.some((h: any) => h.value === item.indicator)) {
          item.fieldHints.unshift({ value: item.indicator, fields });
        }
        aimed += 1;
        this.logger.log(`Job ${jobId}: ${item.indicatorType} ${item.indicator} found in ${fields.join(', ')} (${key})`);
      }
    } catch (err: any) {
      this.logger.warn(`Job ${jobId}: field probe stopped — ${err?.message ?? err}`);
    } finally {
      await session?.close().catch(() => undefined);
    }
    return aimed;
  }

  /**
   * The fields holding exactly `value` in a sample of the scope's events; empty
   * when none do; null when the connector has no tool to run a search with.
   */
  async probe(session: SplunkSession, value: string, scope: ProbeScope): Promise<string[] | null> {
    const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const epoch = (iso?: string) => {
      const t = iso ? Date.parse(iso) : Number.NaN;
      return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
    };
    const earliest = epoch(scope.earliest);
    const latest = epoch(scope.latest);
    const spl = [
      `search index=${quote(scope.index)}`,
      scope.sourcetype ? `sourcetype=${quote(scope.sourcetype)}` : '',
      quote(value),
      earliest !== undefined ? `earliest=${earliest}` : '',
      latest !== undefined ? `latest=${latest}` : '',
      '| head 20 | fields *',
    ].filter(Boolean).join(' ');

    const rows = await session.run(spl);
    if (rows === null) return null;

    const want = value.toLowerCase();
    const hits = new Map<string, number>();
    for (const row of rows) {
      for (const [field, raw] of Object.entries(row ?? {})) {
        if (field.startsWith('_') || field.startsWith('date_') || NOT_CONTENT.has(field)) continue;
        const values = Array.isArray(raw) ? raw : [raw];
        // Exact only: the search it feeds writes field="value", so a field that
        // merely contains the value (uri_path holding a filename) would match nothing.
        if (values.some((v) => String(v).toLowerCase() === want)) hits.set(field, (hits.get(field) ?? 0) + 1);
      }
    }
    return [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
  }

  private cached(key: string): string[] | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (hit.until < Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.fields;
  }

  private remember(key: string, fields: string[]): void {
    // A found field holds for hours; nothing found is retried sooner — the next
    // alert's value may be in events this one's window did not have.
    const ttl = fields.length ? (this.config.get<number>('lookup.probeCacheMs') ?? 6 * 3_600_000) : 600_000;
    this.cache.set(key, { fields, until: Date.now() + ttl });
  }
}
