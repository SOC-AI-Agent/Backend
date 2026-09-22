import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { CatalogService } from './catalog.service';

/**
 * The playbook covering this alert, fetched before any model runs.
 *
 * Matching an alert name to a runbook has one right answer, so it is an HTTP
 * call to the Confluence connector rather than something an agent decides. What
 * comes back is the part of triage a model cannot supply from the log: what
 * makes this detection a true positive, what makes it noise, and what the
 * analyst does next.
 *
 * That is the gap in the suggestion today. It can say what happened and cannot
 * say whether it matters, because nothing has told it what "matters" means for
 * this detection.
 */

export interface PlaybookQuery {
  index?: string;
  sourcetype?: string;
  filters?: Record<string, string>;
  group_by?: string[];
  metrics?: Array<{ fn: string; field?: string }>;
  span?: string;
  sort?: string;
  earliest?: string;
  latest?: string;
}

export interface Playbook {
  page_id: string;
  alert_name: string;
  aliases?: string[];
  url?: string;
  use_case_category?: string;
  version?: string;
  rule_description?: string;
  true_condition?: string;
  false_condition?: string;
  work_around?: string;
  target_audience?: string;
  contact?: string;
  splunk_query?: PlaybookQuery | null;
}

export interface PlaybookMatch {
  matched: boolean;
  /** exact | fuzzy | miss | empty — a fuzzy match is a guess, and it says so. */
  how: string;
  matchedName?: string;
  similarity?: number;
  playbook?: Playbook;
  /** The corpus is yesterday's: a sync failed and the old one is being served. */
  stale?: boolean;
  note?: string;
  /** Why the playbook's own search cannot be trusted, when it cannot. */
  queryProblem?: string;
}

@Injectable()
export class PlaybookService {
  private readonly logger = new Logger(PlaybookService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly catalog: CatalogService,
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.get<string>('playbook.url'));
  }

  async match(alertName: string): Promise<PlaybookMatch | null> {
    const { url, token, timeoutMs } = this.config.get('playbook');
    if (!url || !alertName?.trim()) return null;

    try {
      const { data } = await firstValueFrom(
        this.http.post<any>(
          `${url}/match`,
          { alert_name: alertName },
          { timeout: timeoutMs, headers: token ? { Authorization: `Bearer ${token}` } : {} },
        ),
      );

      const match: PlaybookMatch = {
        matched: Boolean(data.matched),
        how: data.how ?? 'miss',
        matchedName: data.matched_name,
        similarity: data.similarity,
        playbook: data.playbook ?? undefined,
        stale: Boolean(data.corpus?.stale),
        note: data.note,
      };

      if (match.matched && match.playbook?.splunk_query) {
        match.queryProblem = this.checkQuery(match.playbook.splunk_query);
      }
      if (match.stale) {
        this.logger.warn(
          `playbook corpus is stale (${data.corpus?.error ?? 'a sync failed'}) — ` +
            `"${alertName.slice(0, 50)}" was matched against the last good copy`,
        );
      }
      return match;
    } catch (err: any) {
      // Not fatal. A missing playbook makes the suggestion weaker, not wrong,
      // and failing the whole alert over it would be the worse trade.
      const said = err?.response?.data?.error ?? err?.message ?? String(err);
      this.logger.warn(`playbook lookup failed for "${alertName.slice(0, 50)}": ${said}`);
      return { matched: false, how: 'error', note: `playbook lookup failed: ${said}` };
    }
  }

  /**
   * Does the playbook's search still describe this estate?
   *
   * A playbook written two years ago names an index that has since been
   * renamed. Run as-is it returns zero rows, confidently, and reads as "nothing
   * found" — the same failure the data catalogue was built to stop, with the
   * stale source moved from a prompt into the wiki. Checked here so the answer
   * is "the playbook is out of date" rather than "nothing happened".
   */
  private checkQuery(query: PlaybookQuery): string | undefined {
    if (!this.catalog.loaded) return undefined;

    const problems: string[] = [];
    const indexes = this.catalog.indexNames();
    if (query.index && !indexes.includes(query.index)) {
      problems.push(
        `it searches index "${query.index}", which the catalogue does not list ` +
          `(it has: ${indexes.join(', ') || 'nothing'})`,
      );
    }
    if (query.sourcetype && query.index && indexes.includes(query.index)) {
      const known = this.catalog.sourcetypeNames(query.index);
      if (known.length > 0 && !known.includes(query.sourcetype)) {
        problems.push(
          `it searches sourcetype "${query.sourcetype}", which is not in index "${query.index}"`,
        );
      }
    }
    return problems.length > 0
      ? `${problems.join('; ')}. The playbook may predate a change to the estate; ` +
          'an empty result would not mean nothing happened.'
      : undefined;
  }

  /** How the playbook reads to the model, and to the analyst beside it. */
  render(match: PlaybookMatch | null): string {
    if (!match) return '';
    const lines = ['--- PLAYBOOK ---'];

    if (!match.matched) {
      lines.push(
        match.note ??
          'No playbook covers this alert. There is no written definition of what ' +
            'makes it a true positive here, so do not invent one.',
      );
      return lines.join('\n');
    }

    const p = match.playbook!;
    lines.push(`"${p.alert_name}"${p.version ? ` (version ${p.version})` : ''}`);
    if (match.how === 'fuzzy') {
      // Said to the model too. Criteria written for a detection with a
      // different name may not apply, and it should hedge accordingly.
      lines.push(
        `Matched by similarity, not exactly (${match.similarity}). The alert is ` +
          `named differently from the playbook, so check the description fits ` +
          `before relying on the criteria below.`,
      );
    }
    if (match.stale) {
      lines.push('This came from the last good copy — the playbook source could not be re-read.');
    }
    if (p.rule_description) lines.push('', `What it detects: ${p.rule_description}`);
    if (p.true_condition) lines.push('', `TRUE POSITIVE when: ${p.true_condition}`);
    if (p.false_condition) lines.push('', `FALSE POSITIVE when: ${p.false_condition}`);
    if (p.work_around) lines.push('', `The runbook says: ${p.work_around}`);
    if (match.queryProblem) {
      lines.push('', `Note on the playbook's own search: ${match.queryProblem}`);
    }
    return lines.join('\n');
  }
}
