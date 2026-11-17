import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { bearer } from '../ai/ai.service';
import { passages } from '../ai/grounding';
import { CatalogService } from './catalog.service';
import { PlaybookSyncService } from './playbook-sync.service';
import { SourceHint } from './source-map.service';

/**
 * The playbook covering this alert, fetched before any model runs.
 *
 * An HTTP call to soc-ai's playbook index (POST /playbooks/match) rather than
 * something an agent decides. The index is built from the Confluence pages
 * PlaybookSyncService sends it; it matches by name, then by spelling, then by
 * meaning, and says which. What comes back is the part of triage a model cannot
 * supply from the log: what makes this detection a true positive, what makes it
 * noise, and what the analyst does next.
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
  use_case_id?: string;
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
  /** work_around, one step per line. Cited as [PB:step N]; requirements say which step they serve. */
  steps?: string[];
  /** The detection rule's SPL, as the page holds it. Read, never run. */
  detection_spl?: string;
  /** The indexes and sourcetypes that SPL names, checked against the catalogue before use. */
  detection_scope?: { index?: string[]; sourcetype?: string[] };
}

export interface PlaybookMatch {
  matched: boolean;
  /**
   * id | exact | fuzzy | semantic | miss | use_case_mismatch | empty |
   * unindexed | error. `id` is the use case code, the surest of them. Fuzzy and
   * semantic are guesses that cleared a threshold, and they say so.
   * use_case_mismatch is a name that reached a playbook of another use case,
   * refused by soc-ai.
   */
  how: string;
  matchedName?: string;
  /** For a semantic match, which of the playbook's fields the alert was closest to. */
  matchedField?: string;
  similarity?: number;
  playbook?: Playbook;
  /** The index is yesterday's: the last sync failed and the one before is being served. */
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
    private readonly sync: PlaybookSyncService,
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.get<string>('ai.baseUrl'));
  }

  async match(alertName: string, useCaseId?: string): Promise<PlaybookMatch | null> {
    const { baseUrl, token } = this.config.get('ai');
    const { timeoutMs } = this.config.get('playbook');
    if (!baseUrl || !alertName?.trim()) return null;

    try {
      const { data } = await firstValueFrom(
        this.http.post<any>(
          `${baseUrl}/playbooks/match`,
          // soc-ai refuses a name over 512 characters; no detection has one.
          { alert_name: alertName.trim().slice(0, 512), ...(useCaseId ? { use_case_id: useCaseId } : {}) },
          { timeout: timeoutMs, headers: bearer(token) },
        ),
      );

      const match: PlaybookMatch = {
        matched: Boolean(data.matched),
        how: data.how ?? 'miss',
        matchedName: data.matched_name,
        matchedField: data.matched_field,
        similarity: data.similarity,
        playbook: data.playbook ?? undefined,
        stale: this.sync.stale,
        note: data.note,
      };

      if (match.matched && match.playbook?.splunk_query) {
        match.queryProblem = this.checkQuery(match.playbook.splunk_query);
      }
      if (match.stale) {
        this.logger.warn(
          `playbook index is stale (${this.sync.state.error ?? 'the last sync failed'}) — ` +
            `"${alertName.slice(0, 50)}" was matched against the last good copy`,
        );
      }
      return match;
    } catch (err: any) {
      // Not fatal. A missing playbook makes the suggestion weaker, not wrong,
      // and failing the whole alert over it would be the worse trade.
      const said = err?.response?.data?.detail ?? err?.response?.data?.error ?? err?.message ?? String(err);
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

  /**
   * Where the alert's data lives, completed from the playbook's detection SPL.
   *
   * The alert's own fields win: they say where this event is. The SPL only
   * fills what they leave out — no index, or nothing placed it at all — and
   * only from a playbook found by use case id or exact name (a near match's
   * SPL is another detection's), and only with an index and sourcetype the
   * catalogue lists. An index the estate no longer has would aim every search
   * at nothing, and read as "nothing happened".
   */
  fillSource(hint: SourceHint | null, match: PlaybookMatch | null): SourceHint | null {
    if (!match?.matched || !['id', 'exact'].includes(match.how) || !this.catalog.loaded) return hint;
    const scope = match.playbook?.detection_scope;
    const indexes = this.catalog.indexNames();
    const index = (scope?.index ?? []).find((i) => indexes.includes(i));
    if (!index) return hint;
    const known = this.catalog.sourcetypeNames(index);
    const sourcetype = (scope?.sourcetype ?? []).find((s) => known.includes(s));
    const from = `the detection SPL of playbook "${match.playbook!.alert_name}"`;

    if (!hint || hint.unknown) {
      return { index, ...(sourcetype ? { sourcetype } : {}), from };
    }
    if (hint.index) return hint;
    // The alert named a sourcetype: take the index only if it holds that sourcetype.
    if (hint.sourcetype && !known.includes(hint.sourcetype)) return hint;
    return {
      ...hint,
      index,
      ...(!hint.sourcetype && sourcetype ? { sourcetype } : {}),
      from: `${hint.from}; index from ${from}`,
    };
  }

  /**
   * How the playbook reads to the model, and to the analyst beside it.
   *
   * Every part is a passage with a tag the model must cite ([PB:true],
   * [PB:step 2]); the rules under it say how. grounding.ts checks the reply
   * against the same passages, so what is shown and what is checked cannot
   * drift apart.
   */
  render(match: PlaybookMatch | null): string {
    if (!match) return '';
    const lines = ['--- PLAYBOOK ---'];

    if (!match.matched) {
      lines.push(
        match.note ?? 'No playbook covers this alert.',
        '',
        'There is no written definition of a true or false positive for this alert, and no runbook.',
        'Do not give a verdict of true or false positive, do not write criteria or steps as if a',
        'playbook had them, and do not cite [PB:...]. Describe what the evidence shows, and say that',
        "the verdict needs an analyst and this use case's playbook.",
        '--- END OF PLAYBOOK ---',
      );
      return lines.join('\n');
    }

    const p = match.playbook!;
    const tags = [p.use_case_id, p.version && `version ${p.version}`].filter(Boolean).join(', ');
    lines.push(`"${p.alert_name}"${tags ? ` (${tags})` : ''}`);
    if (match.how === 'id') {
      lines.push(`Matched by use case id${p.use_case_id ? ` ${p.use_case_id}` : ''}: this is the playbook for this alert.`);
    }
    if (match.how === 'exact') lines.push('Matched by exact name: this is the playbook for this alert.');
    if (match.how === 'fuzzy') {
      // Said to the model too. Criteria written for a detection with a
      // different name may not apply, and it should hedge accordingly.
      lines.push(
        `Matched by similarity, not exactly (${match.similarity}). The alert is ` +
          `named differently from the playbook, so check the description fits ` +
          `before relying on the criteria below.`,
      );
    }
    if (match.how === 'semantic') {
      // Weaker still: no name matched at all. The alert's name read closest to
      // what this playbook says it detects — a guess about meaning.
      lines.push(
        `Matched by meaning, not by name (${match.similarity}, closest to its ` +
          `${(match.matchedField ?? 'description').replace(/_/g, ' ')}). No playbook ` +
          `carries this alert's name, so check the description fits before relying ` +
          `on the criteria below.`,
      );
    }
    if (match.stale) {
      lines.push('This came from the last good copy — the playbook source could not be re-read.');
    }

    const shown = passages(p);
    for (const passage of shown) {
      lines.push('', `[${passage.id}] ${passage.label}: ${passage.text}`);
    }
    if (match.queryProblem) {
      lines.push('', `Note on the playbook's own search: ${match.queryProblem}`);
    }

    const has = (id: string) => shown.some((s) => s.id === id);
    const steps = shown.filter((s) => s.id.startsWith('PB:step')).length;
    lines.push('', 'HOW TO USE THIS PLAYBOOK — answer from it, not from general knowledge:');
    if (has('PB:true') || has('PB:false')) {
      lines.push(
        '- Judge true or false positive only against [PB:true] and [PB:false], and cite the one the',
        '  verdict rests on. If the evidence does not settle it, say which condition is not yet shown.',
      );
    } else {
      lines.push('- This playbook gives no true or false condition: do not give a verdict, leave it to the analyst.');
    }
    if (steps > 0) {
      lines.push(
        `- Next steps come from the playbook's ${steps} step(s), cited [PB:step 1] to [PB:step ${steps}].`,
        '  Anything else you recommend, start with "Not in the playbook:".',
      );
    }
    lines.push(
      '- Cite the [PB:...] tag after every statement taken from the playbook. Quote it word for word or not at all.',
      '- Where the playbook does not cover something, write "The playbook does not say." Do not fill the gap.',
      '- Evidence from the log, ThreatQ or Splunk is not the playbook: never tag it [PB:...].',
      '--- END OF PLAYBOOK ---',
    );
    return lines.join('\n');
  }
}
