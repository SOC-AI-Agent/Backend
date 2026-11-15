import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';

import { CatalogService } from './catalog.service';
import { Indicator } from './ioc.service';
import { PlaybookMatch } from './playbook.service';
import { SourceHint } from './source-map.service';

/** One row of the question table. */
export interface PlanRule {
  indicator_type: string;
  requirement: string;
  because?: string;
  /** Which catalogue roles to search. Decides direction for an address. */
  roles?: string[];
  hours_before?: number;
  max?: number;
  rank?: number;
  /**
   * Present when this plan groups and counts instead of listing.
   *
   * group_by and metric fields name catalogue ROLES, not field names, so the
   * same plan works on an estate that spells `dest_ip` as `dstip` and one that
   * spells it `dst`. They are resolved against the catalogue like everything
   * else.
   */
  summarise?: {
    group_by?: string[];
    metrics: Array<{ fn: string; field?: string }>;
    span?: string;
    sort?: string;
  };
}

export interface SuggestedLookup {
  /** Plain language, for a person to read and approve. */
  requirement: string;
  /** Which part of the alert made this worth asking. */
  because: string;
  /** Ordered: the ones most likely to change the reading come first. */
  rank: number;

  // ── where to look, resolved from the catalogue ────────────────────────
  // The value being pivoted on, and the kind of thing it is. Present only for
  // lookups that pivot on something the alert contained.
  indicator?: string;
  indicatorType?: string;
  /** The index and sourcetype the alert came from, when they are known. */
  index?: string;
  sourcetype?: string;
  /**
   * The field names that actually carry this indicator here — `srcip`, not
   * `src_ip`. Empty means the catalogue has no field for this role, which is
   * worth saying rather than papering over: searching CIM names against data
   * that does not use them returns zero events and reads as "nothing found".
   */
  fields?: string[];
  /**
   * How far the search had to widen to find a field: the alert's own
   * sourcetype, its index, the whole estate, or nowhere. A hit found at
   * `estate` scope is a weaker link to this alert than one found at
   * `sourcetype` scope, and that difference should not be invisible.
   */
  scope?: 'playbook' | 'sourcetype' | 'index' | 'estate' | 'none';
  /** Field=value pairs the playbook asked for, already its own field names. */
  filters?: Record<string, string>;
  /** Where the alert itself came from, kept for comparison against the above. */
  alertIndex?: string;
  alertSourcetype?: string;
  /** Set when the catalogue could not say where to look. */
  unscoped?: boolean;
  /** Which catalogue roles this search covers — what decides direction. */
  roles?: string[];
  /** Set when this lookup is a grouped count, with roles already resolved. */
  summarise?: {
    group_by?: string[];
    metrics: Array<{ fn: string; field?: string }>;
    span?: string;
    sort?: string;
  };
  /** A frequency check rather than an indicator pivot: the alert to count. */
  frequencyOf?: string;
  days?: number;
  /**
   * The window, as absolute timestamps rather than "-24h".
   *
   * Anchored to when the alert fired, not to when the search runs. A relative
   * window is read at execution time, and in manual mode that is whenever
   * somebody gets round to pressing the button — hours or days later. The
   * events the alert is about then fall outside it and the answer comes back
   * "0 events", which reads as "nothing related happened" rather than "the
   * window moved". Nothing in the result would have said which.
   */
  earliest?: string;
  latest?: string;
}

/**
 * What this alert makes it possible to ask Splunk.
 *
 * Deriving the questions is the same exercise as deriving a field signature —
 * look at which fields are present and work out what they mean — so it is done
 * here, in code, for the same reason: it has one right answer, it is instant,
 * and a model asked to do it will sometimes not bother.
 *
 * These are suggestions, not instructions. The analysing agent picks the ones
 * that would change its reading and ignores the rest; an alert about a blocked
 * connection rarely needs the user's whole day. What this removes is the step
 * where the agent has to invent the question from nothing, which is where it
 * used to answer from the alert alone and report what it had not looked for.
 */
@Injectable()
export class QueryPlanService implements OnModuleInit {
  private readonly logger = new Logger(QueryPlanService.name);

  constructor(
    private readonly catalog: CatalogService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /**
   * The question table, from a file an operator edits.
   *
   * These used to be five shapes written into this method, which meant a
   * detection wanting a different question could not have one without a
   * deploy. The defaults below are the same five, so leaving the file out
   * changes nothing.
   */
  private static readonly DEFAULT_PLANS: PlanRule[] = [
    { indicator_type: 'ip', requirement: 'what else {value} touched in the 24 hours around the alert',
      because: 'ip {value} (from {source})', roles: ['src_ip', 'dest_ip'], hours_before: 24, max: 3, rank: 1 },
    { indicator_type: 'user', requirement: 'what else {value} did in the 24 hours around the alert',
      because: 'user from {source}', roles: ['user'], hours_before: 24, max: 2, rank: 2 },
    { indicator_type: 'hash', requirement: 'where else the file {value} appeared in the week around the alert',
      because: 'hash from {source}', roles: ['hash'], hours_before: 168, max: 2, rank: 1 },
    { indicator_type: 'domain', requirement: 'which hosts reached {value} in the 24 hours around the alert',
      because: 'domain from {source}', roles: ['domain'], hours_before: 24, max: 2, rank: 2 },
  ];

  private plans: PlanRule[] = QueryPlanService.DEFAULT_PLANS;

  onModuleInit(): void {
    const path = process.env.LOOKUP_PLANS_FILE ?? '/catalog/lookup-plans.json';
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { plans?: PlanRule[] };
      const loaded = (raw.plans ?? []).filter((p) => p.indicator_type && p.requirement);
      if (loaded.length === 0) throw new Error('no usable plans in the file');
      this.plans = loaded;
      this.logger.log(`lookup plans loaded from ${path}: ${loaded.length}`);
    } catch (err: any) {
      // Not fatal, but worth saying: running on defaults when someone believes
      // they edited the file is how a question silently never gets asked.
      this.logger.warn(
        `no lookup plans at ${path} (${err?.message ?? err}) — using the ${this.plans.length} built-in defaults`,
      );
    }
  }


  /**
   * Fields that mean the alert is already an aggregate — a threshold crossed, a
   * count over a window. Those are answered by asking how often it has fired
   * rather than by looking up an address.
   */
  private static readonly AGGREGATE_FIELDS = [
    'change_count', 'system_count', 'infected_hosts', 'source_count',
    'risk_event_count', 'count', 'mitre_technique_id_count', 'hit_rate_user_agent',
  ];

  /**
   * Turn `-24h` into a fixed pair of timestamps around the alert.
   *
   * Reaches slightly past the alert on both sides: a detection is the middle of
   * something, not the start of it, and what happened just after the block is
   * usually the question.
   */
  private window(alertTime: Date, hoursBefore: number, hoursAfter = 1): { earliest: string; latest: string } {
    const ms = 3_600_000;
    return {
      earliest: new Date(alertTime.getTime() - hoursBefore * ms).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      latest: new Date(alertTime.getTime() + hoursAfter * ms).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  }

  /**
   * Turn the roles a summarise plan names into this estate's field names.
   *
   * A metric on a role the catalogue cannot place is dropped rather than sent
   * as the role name: `dc(dest_ip)` against logs that call it `dstip` counts
   * nothing and returns zero, which reads as an answer.
   */
  private resolveRoles(
    summarise: NonNullable<PlanRule['summarise']>,
    index?: string,
    sourcetype?: string,
  ) {
    const field = (role: string) =>
      this.catalog.fieldsForRole(role, index, sourcetype)[0] ??
      this.catalog.fieldsForRole(role)[0];

    const groupBy = (summarise.group_by ?? []).map(field).filter(Boolean) as string[];
    const metrics = summarise.metrics
      .map((m) => (m.field ? { fn: m.fn, field: field(m.field) } : { fn: m.fn }))
      .filter((m) => !('field' in m) || m.field) as Array<{ fn: string; field?: string }>;
    const sortRole = summarise.sort?.replace(/^-/, '');
    const sorted =
      summarise.sort && sortRole && sortRole !== 'count'
        ? (() => {
            const f = field(sortRole);
            return f ? `${summarise.sort!.startsWith('-') ? '-' : ''}${f}` : undefined;
          })()
        : summarise.sort;

    return { group_by: groupBy, metrics, span: summarise.span, sort: sorted };
  }

  build(
    indicators: Indicator[],
    source: SourceHint | null,
    alertName: string,
    rawLog: string,
    alertTime: Date = new Date(),
    playbook: PlaybookMatch | null = null,
  ): SuggestedLookup[] {
    const day = this.window(alertTime, 24);
    const week = this.window(alertTime, 24 * 7);
    const out: SuggestedLookup[] = [];
    const seen = new Set<string>();
    const index = source?.index;
    const sourcetype = source?.sourcetype;

    const add = (
      requirement: string,
      because: string,
      rank: number,
      pivot?: { value: string; type: string; roles?: string[] },
      window?: { earliest: string; latest: string },
      summarise?: PlanRule['summarise'],
    ) => {
      const key = requirement.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      if (!pivot) {
        out.push({ requirement, because, rank, ...(window ?? day) });
        return;
      }

      // Resolved once, here, from the catalogue — not left for the query agent
      // to work out from a schema it has to be shown first. The scope may be
      // wider than the alert's own sourcetype: what is worth searching for is
      // often recorded somewhere else in the estate.
      // The rule's roles decide direction: src_ip alone asks what this address
      // reached out as, both together ask what it touched either way. Falling
      // back to every role for the type keeps a rule that names none working.
      const where = this.catalog.resolveIndicator(pivot.type, index, sourcetype, pivot.roles);
      if (where.scope === 'none' && this.catalog.loaded) {
        this.logger.warn(
          `nothing in the catalogue records a ${pivot.type} — ` +
            `"${requirement.slice(0, 60)}" cannot be aimed anywhere`,
        );
      }
      out.push({
        requirement,
        because,
        rank,
        indicator: pivot.value,
        indicatorType: pivot.type,
        roles: pivot.roles,
        // Where the search actually lands, which is not always where the alert
        // came from. Left undefined at estate scope: there is no one index.
        index: where.index,
        sourcetype: where.sourcetype,
        alertIndex: index,
        alertSourcetype: sourcetype,
        scope: where.scope,
        fields: where.fields,
        unscoped: where.fields.length === 0,
        ...(where.via ? { aimedBy: where.via } : {}),
        // Roles become field names here, where the catalogue is. A plan that
        // said `dest_ip` is only runnable once something turns that into
        // whatever this estate calls it.
        ...(summarise ? { summarise: this.resolveRoles(summarise, index, sourcetype) } : {}),
        ...(window ?? day),
      });
    };

    const byType = (type: string) => indicators.filter((i) => i.type === type);

    // The playbook's own search comes first when there is one. A person who
    // knew both this detection and this estate wrote it; no template derived
    // from the indicators is a better guess than that. It is skipped when the
    // catalogue says it points somewhere that no longer exists — a stale
    // playbook returns zero rows confidently, which reads as "nothing found".
    const query = playbook?.matched ? playbook.playbook?.splunk_query : undefined;
    if (query && !playbook?.queryProblem) {
      const summarise = query.metrics?.length
        ? { group_by: query.group_by, metrics: query.metrics, span: query.span, sort: query.sort }
        : undefined;
      out.push({
        requirement:
          `what the playbook for "${playbook!.playbook!.alert_name}" says to look at` +
          (playbook!.playbook!.version ? ` (v${playbook!.playbook!.version})` : ''),
        because: `written for this detection by a person, matched ${playbook!.how}`,
        rank: 0,
        index: query.index,
        sourcetype: query.sourcetype,
        scope: 'playbook',
        filters: query.filters,
        ...(summarise ? { summarise } : {}),
        ...this.window(alertTime, 24),
      });
      seen.add('playbook');
    } else if (query && playbook?.queryProblem) {
      this.logger.warn(
        `the playbook for "${alertName.slice(0, 40)}" has a search that no longer fits: ` +
          playbook.queryProblem,
      );
    }

    // One pass over the table, in the order it is written. What used to be
    // five hardcoded loops is now whatever the operator put in the file.
    for (const rule of this.plans) {
      const hours = rule.hours_before ?? 24;
      const when = this.window(alertTime, hours);
      for (const found of byType(rule.indicator_type).slice(0, rule.max ?? 2)) {
        const fill = (text: string) =>
          text.replace(/\{value\}/g, found.value).replace(/\{source\}/g, found.source);
        add(
          fill(rule.requirement),
          fill(rule.because ?? '{value} (from {source})'),
          rule.rank ?? 2,
          { value: found.value, type: rule.indicator_type, roles: rule.roles },
          when,
          rule.summarise,
        );
      }
    }

    // A correlation search that has fired a thousand times this week is a
    // different alert from one firing for the first time, and the alert itself
    // cannot say which it is.
    const includeFrequency = this.config?.get<boolean>('lookup.alertFrequency') ?? true;
    if (includeFrequency && alertName.trim()) {
      // Plannable without an indicator: the backend has the name and the
      // window already. Handing those to an agent so it could pass them
      // straight through cost 109 of the 111 seconds a whole lookup takes.
      out.push({
        requirement: `how often the alert "${alertName.trim()}" has fired in the last 7 days`,
        because: 'to tell routine noise from a first sighting',
        rank: 3,
        frequencyOf: alertName.trim(),
        days: 7,
        // Anchored like the rest. `-7d` read at execution time drifts away
        // from the alert exactly as `-24h` did, just more slowly, and "has not
        // fired in 7 days" is a wrong answer that reads as reassurance.
        ...this.window(alertTime, 24 * 7),
      });
      seen.add(`how often the alert "${alertName.trim()}" has fired in the last 7 days`.toLowerCase());
    }

    const present = new Set(
      [...rawLog.matchAll(/\b([A-Za-z][\w.]{2,40})\s*=/g)].map((m) => m[1].toLowerCase()),
    );
    const aggregate = QueryPlanService.AGGREGATE_FIELDS.filter((f) => present.has(f));
    if (aggregate.length > 0) {
      add(
        'which hosts or users make up the count this alert reports',
        `the alert is an aggregate (${aggregate.join(', ')}), so the total hides who is in it`,
        1,
      );
    }

    if (out.length === 0) {
      this.logger.warn(`no lookups follow from alert "${alertName.slice(0, 60)}"`);
    }
    return out.sort((a, b) => a.rank - b.rank);
  }

  /** How the suggestions read to the model. */
  render(lookups: SuggestedLookup[], source: SourceHint | null): string {
    const lines = ['--- WHAT CAN BE ASKED OF SPLUNK ---'];

    if (lookups.length === 0) {
      lines.push(
        'Nothing follows automatically from this alert — it carries no address,',
        'user, hash or domain to pivot on. Read it first and decide whether a log',
        'search would add anything.',
      );
      return lines.join('\n');
    }

    lines.push(
      'These follow from what the alert contains. Ask for the ones that would',
      'change your reading and ignore the rest — asking for all of them is slow',
      'and most of it will not matter.',
      '',
    );
    for (const l of lookups) {
      lines.push(`- ${l.requirement}`);
      lines.push(`    (${l.because})`);
      // Where it has already been worked out, say so. The point is not to tell
      // the model the schema — it is to record that this search is aimed, so a
      // zero-result answer means "not there" rather than "looked in the wrong
      // place", which are the two readings nobody could tell apart before.
      if (l.fields?.length) {
        const where = [l.index && `index ${l.index}`, l.sourcetype && `sourcetype ${l.sourcetype}`]
          .filter(Boolean)
          .join(', ');
        lines.push(`    searches ${l.fields.join(' / ')}${where ? ` in ${where}` : ' across every index'}`);
        if (l.scope === 'estate' || l.scope === 'index') {
          lines.push(
            `    note: nothing in ${l.alertSourcetype ?? l.alertIndex ?? 'this alert\'s own data'} ` +
              'records this, so the search reaches into other data — a match there is ' +
              'related to the indicator, not necessarily to this alert',
          );
        }
      } else if (l.indicatorType) {
        lines.push(
          `    NOT AIMED: the catalogue has no field for a ${l.indicatorType} here, ` +
            'so a result of nothing may only mean the wrong field was searched',
        );
      }
    }

    if (source?.domain || source?.sourcetype) {
      lines.push(
        '',
        `Start with the ${source.sourcetype ?? source.domain} data named above.`,
      );
    }
    return lines.join('\n');
  }
}
