import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import {
  BuiltSearch,
  SplPolicy,
  buildFrequency,
  buildIndicatorSearch,
  buildSummary,
} from './spl';

/**
 * Run a planned search against Splunk, without a model.
 *
 * The plan already names the indicator, its kind, the fields that carry it in
 * this estate, and the index and sourcetype to look in. Handing that to a query
 * agent so it could emit the same parameters back as JSON cost 488 seconds per
 * lookup on CPU-only inference — of which Splunk itself used 0.409. The model
 * added nothing to the search; it transcribed a plan the backend wrote.
 *
 * So the backend writes the SPL (spl.ts: the allowlist, the field checks, the
 * quoting), sends it to the connector's /query route, and shapes what comes back.
 * The connector only runs it, and refuses anything that is not a read-only search
 * over an allowed index — a second check on the same rules.
 */

export interface PlannedSearch {
  indicator: string;
  indicatorType: string;
  fields: string[];
  index?: string;
  sourcetype?: string;
  earliest?: string;
  latest?: string;
  maxCount?: number;
}

export interface SearchResult {
  indicator: string;
  indicator_type: string;
  fields_searched: string[];
  index?: string | null;
  sourcetype?: string | null;
  count: number;
  /** The search stopped at `limit`; there may be more. */
  capped: boolean;
  limit: number;
  earliest: string;
  latest: string;
  events: Array<Record<string, unknown>>;
  spl: string;
}

export interface PlannedSummary {
  index: string;
  sourcetype?: string;
  filters?: Record<string, string>;
  groupBy?: string[];
  metrics: Array<{ fn: string; field?: string }>;
  span?: string;
  sort?: string;
  earliest?: string;
  latest?: string;
  maxRows?: number;
}

export interface SummaryResult {
  index: string;
  sourcetype?: string | null;
  group_by: string[];
  rows: Array<Record<string, unknown>>;
  count: number;
  capped: boolean;
  limit: number;
  earliest: string;
  latest: string;
  spl: string;
}

export interface FrequencyResult {
  alert_name: string;
  window_days: number;
  total: number;
  days_seen: number;
  mean_per_active_day: number;
  per_day: Record<string, number>;
  earliest: string;
  latest: string;
  spl: string;
}

// A 7b model runs on a 4k context. Whole Splunk events do not fit, so trim each one
// to the fields that carry meaning plus a bounded slice of _raw.
const MAX_RAW_CHARS = 800;
// Splunk bookkeeping. Dropped because none of it helps read an event, and two of
// them actively mislead: `host` on forwarded syslog is the forwarder, not the
// machine the alert is about, and `source` is a file path on that forwarder.
const DROPPED_FIELDS = new Set([
  '_bkt', '_cd', '_indextime', '_serial', '_si', '_sourcetype', '_kv',
  'linecount', 'punct', 'splunk_server', 'eventtype', 'tag', 'timestamp',
  'host', 'source',
]);

function trimEvent(event: Record<string, unknown>): Record<string, unknown> {
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (DROPPED_FIELDS.has(key)) continue;
    trimmed[key] =
      key === '_raw' && typeof value === 'string' && value.length > MAX_RAW_CHARS
        ? `${value.slice(0, MAX_RAW_CHARS)}… [${value.length - MAX_RAW_CHARS} chars truncated]`
        : value;
  }
  return trimmed;
}

@Injectable()
export class SplunkService {
  private readonly logger = new Logger(SplunkService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.get<string>('splunk.url'));
  }

  /**
   * Turn an axios failure back into what the connector actually said.
   *
   * Without this an analyst reads "Request failed with status code 400" for
   * what the connector explained precisely: "index 'notable' is not allowed;
   * permitted: main". The message existed the whole way up and the HTTP client
   * threw it away — the same shape of loss this pipeline keeps being bitten by.
   */
  private fail(err: any, what: string): never {
    const said = err?.response?.data?.error ?? err?.response?.data?.detail;
    throw new Error(said ? `${what}: ${said}` : `${what}: ${err?.message ?? String(err)}`);
  }

  private policy(): SplPolicy {
    const { allowedIndexes, maxCount } = this.config.get('splunk');
    return { allowedIndexes, maxCount };
  }

  /** Send built SPL to the connector and hand back Splunk's rows, untouched. */
  private async run(built: BuiltSearch, what: string): Promise<Array<Record<string, unknown>>> {
    const { url, token, timeoutMs } = this.config.get('splunk');
    if (!url) throw new Error('SPLUNK_MCP_URL is not set');
    try {
      const { data } = await firstValueFrom(
        this.http.post<{ results?: Array<Record<string, unknown>> }>(
          `${url}/query`,
          { spl: built.spl, earliest: built.earliest, latest: built.latest, count: built.count },
          { timeout: timeoutMs, headers: token ? { Authorization: `Bearer ${token}` } : {} },
        ),
      );
      return data.results ?? [];
    } catch (err: any) {
      this.fail(err, what);
    }
  }

  async search(plan: PlannedSearch): Promise<SearchResult> {
    const what = `searching ${plan.fields.join('/')} for ${plan.indicator}`;
    let built: BuiltSearch;
    try {
      built = buildIndicatorSearch(this.policy(), {
        indicator: plan.indicator,
        fields: plan.fields,
        index: plan.index,
        sourcetype: plan.sourcetype,
        earliest: plan.earliest ?? '-24h',
        latest: plan.latest ?? 'now',
        maxCount: plan.maxCount ?? 20,
      });
    } catch (err: any) {
      this.fail(err, what);
    }

    const rows = await this.run(built, what);
    const events = rows.map((row) => {
      // Which field each event matched on. The search is an OR across every field
      // that could carry this indicator, so "2 events" alone does not say whether
      // the host reached out or was reached — for an address, the difference
      // between a beacon and a scan. Worked out from the row as Splunk returned
      // it, before trimming drops fields.
      const matchedOn = plan.fields.filter((f) => String(row[f] ?? '') === plan.indicator);
      return { ...trimEvent(row), matched_on: matchedOn };
    });

    return {
      indicator: plan.indicator,
      indicator_type: plan.indicatorType,
      // Saying which fields were searched turns an empty result from "nothing
      // happened" into something checkable.
      fields_searched: plan.fields,
      index: plan.index ?? null,
      sourcetype: plan.sourcetype ?? null,
      count: events.length,
      // `| head N` stops at N and says nothing. A count of 20 out of 20 is
      // indistinguishable from 20 out of four thousand, and a reader who cannot
      // see the cut takes the first for the whole.
      capped: events.length >= built.count,
      limit: built.count,
      earliest: built.earliest,
      latest: built.latest,
      events,
      spl: built.spl,
    };
  }

  /**
   * Group and count instead of listing.
   *
   * The question a list cannot answer: a host that reached five hundred
   * addresses and one that reached a single address both return twenty raw
   * events, and only an aggregation tells them apart.
   */
  async summarise(plan: PlannedSummary): Promise<SummaryResult> {
    const what = `summarising ${plan.index} by ${(plan.groupBy ?? []).join(', ') || 'time'}`;
    let built: ReturnType<typeof buildSummary>;
    try {
      built = buildSummary(this.policy(), {
        index: plan.index,
        sourcetype: plan.sourcetype,
        filters: plan.filters,
        groupBy: plan.groupBy,
        metrics: plan.metrics,
        span: plan.span,
        sort: plan.sort,
        earliest: plan.earliest ?? '-24h',
        latest: plan.latest ?? 'now',
        maxRows: plan.maxRows ?? 50,
      });
    } catch (err: any) {
      this.fail(err, what);
    }

    // Rows are returned as they came: they are aggregates, so nothing in them is
    // a raw event to trim, and a column named `host` is the thing that was asked for.
    const rows = await this.run(built, what);
    return {
      index: plan.index,
      sourcetype: plan.sourcetype ?? null,
      group_by: built.groupBy,
      rows,
      count: rows.length,
      // A row count at the ceiling is a floor, not a total.
      capped: rows.length >= built.count,
      limit: built.count,
      earliest: built.earliest,
      latest: built.latest,
      spl: built.spl,
    };
  }

  /** A summary as a table an analyst can read, not a JSON dump. */
  renderSummary(r: SummaryResult): string {
    const where = [r.index, r.sourcetype].filter(Boolean).join('/');
    const head =
      `Grouped ${where} by ${r.group_by.join(', ') || 'nothing'}, ${r.earliest} to ${r.latest} — ` +
      `${r.capped ? `at least ${r.count}` : r.count} row(s).` +
      (r.capped ? ` Stopped at ${r.limit}; there may be more.` : '');
    if (r.count === 0) return `${head}\nNothing matched in that window.`;

    const columns = [...new Set(r.rows.flatMap((row) => Object.keys(row)))];
    const lines = r.rows.map(
      (row) => '  ' + columns.map((c) => `${c}=${row[c] ?? '-'}`).join('  '),
    );
    return [head, ...lines].join('\n');
  }

  async frequency(
    alertName: string,
    days = 7,
    earliest?: string,
    latest?: string,
  ): Promise<FrequencyResult> {
    const what = `counting how often "${alertName}" fired`;
    const { alertIndex, alertNameField } = this.config.get('splunk');
    let built: BuiltSearch;
    try {
      built = buildFrequency(this.policy(), { alertIndex, alertNameField }, { alertName, days, earliest, latest });
    } catch (err: any) {
      this.fail(err, what);
    }

    const rows = await this.run(built, what);
    const perDay: Record<string, number> = {};
    for (const row of rows) {
      if (row._time) perDay[String(row._time)] = Number.parseInt(String(row.count), 10) || 0;
    }
    const counts = Object.values(perDay);
    const total = counts.reduce((sum, n) => sum + n, 0);

    return {
      alert_name: alertName,
      window_days: days,
      total,
      days_seen: counts.length,
      mean_per_active_day: counts.length ? Math.round((total / counts.length) * 100) / 100 : 0,
      per_day: perDay,
      earliest: built.earliest,
      latest: built.latest,
      spl: built.spl,
    };
  }

  renderFrequency(r: FrequencyResult): string {
    if (r.total === 0) {
      return (
        `"${r.alert_name}" did not fire between ${r.earliest} and ${r.latest}. ` +
        'Either this is the first sighting, or these alerts are not recorded where ' +
        'this looked — worth knowing which before reading anything into it.'
      );
    }
    const days = Object.entries(r.per_day)
      .map(([day, n]) => `  ${day.slice(0, 10)}  ${n}`)
      .join('\n');
    return (
      `"${r.alert_name}" fired ${r.total} time(s) over ${r.window_days} days, ` +
      `on ${r.days_seen} of them (mean ${r.mean_per_active_day} per active day).\n${days}`
    );
  }

  /**
   * The result as an analyst reads it.
   *
   * Names the fields that were searched, because that is what turns "0 events"
   * from "nothing happened" into "nothing is recorded in srcip or dstip" — the
   * two readings that used to be indistinguishable.
   */
  render(result: SearchResult): string {
    const where = [result.index, result.sourcetype].filter(Boolean).join('/') || 'every allowed index';
    const window = `${result.earliest} to ${result.latest}`;
    const head =
      `Searched ${result.fields_searched.join(' / ')} in ${where}, ${window} — ` +
      // "at least" when the search hit its ceiling: the number is a floor, and
      // reading it as a total is how twenty of four thousand becomes "twenty".
      `${result.capped ? `at least ${result.count}` : result.count} event(s).` +
      (result.capped ? ` The search stopped at ${result.limit}; there may be more.` : '');
    if (result.count === 0) {
      return `${head}\nNothing is recorded in those fields for this value in that window.`;
    }
    const lines = result.events.map(
      (e) =>
        '- ' +
        Object.entries(e)
          .filter(([k, v]) => v !== null && v !== '' && k !== '_raw')
          .map(([k, v]) => `${k}=${String(v)}`)
          .join('  '),
    );
    return [head, ...lines].join('\n');
  }
}
