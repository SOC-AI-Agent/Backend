import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

/**
 * Run a planned search against the Splunk connector, without a model.
 *
 * The plan already names the indicator, its kind, the fields that carry it in
 * this estate, and the index and sourcetype to look in. Handing that to the
 * query agent so it can emit the same parameters back as JSON cost 488 seconds
 * per lookup on CPU-only inference — of which Splunk itself used 0.409. The
 * model added nothing to the search; it transcribed a plan the backend wrote.
 *
 * So a planned lookup goes straight to the connector's /search route. The query
 * agent stays for what nobody planned: a requirement that is not a single
 * indicator, or one where the catalogue left a gap and a person still wants it
 * tried.
 *
 * Nothing about safety is skipped by going this way. The route runs the same
 * code the tool does — the same index allowlist, the same field-name checks,
 * the same quoting — because both call one shared implementation.
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

  async search(plan: PlannedSearch): Promise<SearchResult> {
    const { url, token, timeoutMs } = this.config.get('splunk');
    if (!url) throw new Error('SPLUNK_MCP_URL is not set');

    try {
    const { data } = await firstValueFrom(
      this.http.post<SearchResult>(
        `${url}/search`,
        {
          indicator: plan.indicator,
          indicator_type: plan.indicatorType,
          fields: plan.fields,
          index: plan.index,
          sourcetype: plan.sourcetype,
          earliest: plan.earliest ?? '-24h',
          latest: plan.latest ?? 'now',
          max_count: plan.maxCount ?? 20,
        },
        {
          timeout: timeoutMs,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      ),
    );
    return data;
    } catch (err: any) {
      this.fail(err, `searching ${plan.fields.join('/')} for ${plan.indicator}`);
    }
  }

  /**
   * Group and count instead of listing.
   *
   * The question a list cannot answer: a host that reached five hundred
   * addresses and one that reached a single address both return twenty raw
   * events, and only an aggregation tells them apart.
   */
  async summarise(plan: PlannedSummary): Promise<SummaryResult> {
    const { url, token, timeoutMs } = this.config.get('splunk');
    if (!url) throw new Error('SPLUNK_MCP_URL is not set');
    try {
      const { data } = await firstValueFrom(
        this.http.post<SummaryResult>(
          `${url}/summarise`,
          {
            index: plan.index,
            sourcetype: plan.sourcetype,
            filters: plan.filters,
            group_by: plan.groupBy,
            metrics: plan.metrics,
            span: plan.span,
            sort: plan.sort,
            earliest: plan.earliest,
            latest: plan.latest,
            max_rows: plan.maxRows ?? 50,
          },
          { timeout: timeoutMs, headers: token ? { Authorization: `Bearer ${token}` } : {} },
        ),
      );
      return data;
    } catch (err: any) {
      this.fail(err, `summarising ${plan.index} by ${(plan.groupBy ?? []).join(', ') || 'time'}`);
    }
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
    const { url, token, timeoutMs } = this.config.get('splunk');
    if (!url) throw new Error('SPLUNK_MCP_URL is not set');
    try {
      const { data } = await firstValueFrom(
        this.http.post<FrequencyResult>(
          `${url}/frequency`,
          { alert_name: alertName, days, earliest, latest },
          { timeout: timeoutMs, headers: token ? { Authorization: `Bearer ${token}` } : {} },
        ),
      );
      return data;
    } catch (err: any) {
      this.fail(err, `counting how often "${alertName}" fired`);
    }
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
