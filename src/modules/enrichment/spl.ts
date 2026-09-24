/**
 * SPL construction, done here and never by the model.
 *
 * The backend plans a search — which indicator, which fields carry it in this
 * estate, which index and sourcetype — and this module turns that plan into the one
 * search string that goes to Splunk. Nothing a caller supplies is interpolated raw,
 * so a value carried in from an attacker-controlled log field cannot close the quote
 * and append `| delete`.
 *
 * It lived in the Splunk connector (spl.py) while the connector built the searches.
 * The connector now only runs what it is sent, and refuses anything that is not a
 * read-only search over an allowed index (MCP-Server/Splunk/spl.py, check_query) —
 * a second check on the same rules, not the only one.
 *
 * Ported from spl.py rule for rule. Where the two can differ it is on the strict
 * side: a `$` in a JavaScript pattern does not match before a trailing newline the
 * way Python's does.
 */

/** A parameter this module will not put into a search. */
export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

/** What may be searched, and how much may come back. */
export interface SplPolicy {
  /** The index allowlist, or ['*'] to opt out on purpose. Empty refuses everything. */
  allowedIndexes: string[];
  /** Ceiling on rows, whatever the plan asks for. */
  maxCount: number;
}

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
const INDEX_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const TIME_RE =
  /^(?:now|[+-]?\d{1,6}(?:s|m|h|d|w|mon|y)(?:@[a-z]{1,3})?|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?|\d{10})$/;
const SPAN_RE = /^\d{1,4}(?:s|m|h|d)$/;

export const MAX_VALUE_LEN = 512;
export const MAX_GROUP_BY = 4;
export const MAX_METRICS = 6;

const restrictionDisabled = (policy: SplPolicy): boolean =>
  policy.allowedIndexes.length === 1 && policy.allowedIndexes[0] === '*';

/** Render a value as an SPL double-quoted literal. */
export function quoteValue(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  if (text.length > MAX_VALUE_LEN) throw new QueryError(`value too long (max ${MAX_VALUE_LEN} chars)`);
  if (/[\r\n\0]/.test(text)) throw new QueryError('value may not contain newlines or null bytes');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function checkField(name: string): string {
  if (typeof name !== 'string' || !FIELD_RE.test(name)) {
    throw new QueryError(`invalid field name: '${name}'`);
  }
  return name;
}

export function checkTime(value: string, label: string): string {
  if (typeof value !== 'string' || !TIME_RE.test(value)) {
    throw new QueryError(
      `invalid ${label}: '${value}' — use a relative modifier (-24h, -7d@d), ` +
        "an ISO-8601 timestamp, an epoch, or 'now'",
    );
  }
  return value;
}

export function checkCount(requested: number, policy: SplPolicy): number {
  if (!Number.isInteger(requested) || requested < 1) throw new QueryError('max_count must be >= 1');
  return Math.min(requested, policy.maxCount);
}

/** Reject anything outside the configured allowlist. */
export function checkIndex(name: string, policy: SplPolicy): string {
  if (typeof name !== 'string' || !INDEX_RE.test(name)) {
    throw new QueryError(`invalid index name: '${name}'`);
  }
  if (restrictionDisabled(policy)) return name;
  if (policy.allowedIndexes.length === 0) {
    // Said plainly, not as "permitted: " with nothing after it.
    throw new QueryError('SPLUNK_ALLOWED_INDEXES is not set, so no index may be searched');
  }
  if (!policy.allowedIndexes.includes(name)) {
    throw new QueryError(
      `index '${name}' is not allowed; permitted: ${policy.allowedIndexes.join(', ')}`,
    );
  }
  return name;
}

/** `index=` for one index, or an OR over the whole allowlist when unscoped. */
export function indexClause(index: string | undefined | null, policy: SplPolicy): string {
  if (index !== undefined && index !== null) {
    return `index=${quoteValue(checkIndex(index, policy))}`;
  }
  if (restrictionDisabled(policy)) return 'index=*';
  if (policy.allowedIndexes.length === 0) {
    // Refused rather than searched: an empty allowlist that fell through to
    // "everything" is the failure this list exists to prevent.
    throw new QueryError('SPLUNK_ALLOWED_INDEXES is not set, so no index may be searched');
  }
  const terms = policy.allowedIndexes.map((i) => `index=${quoteValue(checkIndex(i, policy))}`);
  return terms.length > 1 ? `(${terms.join(' OR ')})` : terms[0];
}

/** `field="value"` pairs, ANDed. */
export function equalityTerms(filters: Record<string, string | undefined | null>): string {
  return Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([field, value]) => `${checkField(field)}=${quoteValue(value)}`)
    .join(' ');
}

/** `(a="v" OR b="v")` — one indicator across several possible field names. */
export function anyOfTerms(fields: string[], value: string): string {
  if (fields.length === 0) throw new QueryError('no fields given to search for the indicator');
  const quoted = quoteValue(value);
  return `(${fields.map((f) => `${checkField(f)}=${quoted}`).join(' OR ')})`;
}

// Aggregation functions a caller may ask for, and how each is written. An
// allowlist rather than a check: `fn` is a key into this, never text that gets
// interpolated.
const STATS_FUNCTIONS: Record<string, string> = {
  count: 'count',
  distinct_count: 'dc',
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
  values: 'values',
};

export function checkSpan(value: string): string {
  if (typeof value !== 'string' || !SPAN_RE.test(value)) {
    throw new QueryError(`invalid span: '${value}' — use a bucket size like 5m, 1h or 1d`);
  }
  return value;
}

export interface Metric {
  fn: string;
  field?: string;
}

/**
 * `stats count, dc(dstip) as dstip_distinct_count by srcip, action`
 *
 * The output column is named after what produced it, because a column called
 * `dc(dstip)` is awkward to read and impossible to sort on by name.
 */
export function statsClause(metrics: Metric[], groupBy: string[]): string {
  if (!metrics.length) throw new QueryError('at least one metric is required');
  if (metrics.length > MAX_METRICS) throw new QueryError(`too many metrics (max ${MAX_METRICS})`);
  if (groupBy.length > MAX_GROUP_BY) throw new QueryError(`too many group_by fields (max ${MAX_GROUP_BY})`);

  const parts: string[] = [];
  for (const metric of metrics) {
    const name = metric?.fn;
    // Own keys only: `'toString' in STATS_FUNCTIONS` is true, and its value is a function.
    if (!Object.prototype.hasOwnProperty.call(STATS_FUNCTIONS, name)) {
      throw new QueryError(
        `unknown metric '${name}'; available: ${Object.keys(STATS_FUNCTIONS).sort().join(', ')}`,
      );
    }
    if (name === 'count') {
      parts.push('count');
      continue;
    }
    const field = metric?.field;
    if (!field) throw new QueryError(`metric '${name}' needs a field`);
    checkField(field);
    const column = `${field}_${name}`;
    parts.push(
      name === 'values' ? `values(${field}) as ${column}` : `${STATS_FUNCTIONS[name]}(${field}) as ${column}`,
    );
  }

  let clause = `stats ${parts.join(', ')}`;
  if (groupBy.length) clause += ` by ${groupBy.map(checkField).join(', ')}`;
  return clause;
}

/**
 * `| sort -count `. The column must be one the stats above actually produced —
 * sorting on a column that does not exist is silently ignored by Splunk, and the
 * reader would take the first rows for the largest.
 */
export function sortClause(sort: string | undefined | null, allowed: Set<string>): string {
  if (!sort) return '';
  const descending = sort.startsWith('-');
  const column = descending ? sort.slice(1) : sort;
  if (!allowed.has(column)) {
    throw new QueryError(
      `cannot sort on '${column}'; the search produces: ${[...allowed].sort().join(', ')}`,
    );
  }
  return `| sort ${descending ? '-' : ''}${checkField(column)} `;
}

// ── The three searches the backend runs ─────────────────────────────────────

export interface BuiltSearch {
  /** Exactly what is sent to the connector, and what the answer reports. */
  spl: string;
  earliest: string;
  latest: string;
  /** The row ceiling to ask for, already capped. */
  count: number;
}

export interface IndicatorSearchPlan {
  indicator: string;
  fields: string[];
  index?: string | null;
  sourcetype?: string | null;
  earliest?: string;
  latest?: string;
  maxCount?: number;
}

/** One indicator across the fields that carry it, in one index and sourcetype. */
export function buildIndicatorSearch(policy: SplPolicy, plan: IndicatorSearchPlan): BuiltSearch {
  const count = checkCount(plan.maxCount ?? 20, policy);
  const earliest = checkTime(plan.earliest ?? '-24h', 'earliest');
  const latest = checkTime(plan.latest ?? 'now', 'latest');

  const terms = [indexClause(plan.index, policy), anyOfTerms(plan.fields, plan.indicator)];
  if (plan.sourcetype) terms.push(equalityTerms({ sourcetype: plan.sourcetype }));

  return { spl: `search ${terms.filter(Boolean).join(' ')} | head ${count}`, earliest, latest, count };
}

export interface SummaryPlan {
  index: string;
  sourcetype?: string | null;
  filters?: Record<string, string> | null;
  groupBy?: string[];
  metrics: Metric[];
  span?: string | null;
  sort?: string | null;
  earliest?: string;
  latest?: string;
  maxRows?: number;
}

export interface BuiltSummary extends BuiltSearch {
  /** The grouping as searched — `_time` is added when a span is given. */
  groupBy: string[];
}

/** Group and count instead of listing. */
export function buildSummary(policy: SplPolicy, plan: SummaryPlan): BuiltSummary {
  const count = checkCount(plan.maxRows ?? 50, policy);
  const earliest = checkTime(plan.earliest ?? '-24h', 'earliest');
  const latest = checkTime(plan.latest ?? 'now', 'latest');
  let groupBy = [...(plan.groupBy ?? [])];

  const terms = [indexClause(plan.index, policy)];
  const scoped = equalityTerms({ sourcetype: plan.sourcetype, ...(plan.filters ?? {}) });
  if (scoped) terms.push(scoped);

  let pipeline = `search ${terms.join(' ')} `;
  if (plan.span) {
    // Bucketing goes before stats, and _time joins the grouping — otherwise the bin
    // is computed and then thrown away by the aggregation.
    pipeline += `| bin _time span=${checkSpan(plan.span)} `;
    groupBy = ['_time', ...groupBy];
  }

  pipeline += `| ${statsClause(plan.metrics, groupBy)} `;

  const produced = new Set<string>(['count', ...groupBy]);
  for (const m of plan.metrics) if (m.field) produced.add(`${m.field}_${m.fn}`);
  pipeline += sortClause(plan.sort, produced);
  pipeline += `| head ${count}`;

  return { spl: pipeline.trim(), earliest, latest, count, groupBy };
}

export interface FrequencyPlan {
  alertName: string;
  days: number;
  /** Absolute window, when the caller has one — a relative one drifts from the alert. */
  earliest?: string;
  latest?: string;
}

export interface FrequencyConfig {
  alertIndex: string;
  alertNameField: string;
}

/** How often one alert has fired, per day. */
export function buildFrequency(
  policy: SplPolicy,
  config: FrequencyConfig,
  plan: FrequencyPlan,
): BuiltSearch {
  if (!Number.isInteger(plan.days) || plan.days < 1 || plan.days > 90) {
    throw new QueryError('days must be between 1 and 90');
  }
  const nameField = checkField(config.alertNameField);
  const spl =
    `search ${indexClause(config.alertIndex, policy)} ` +
    `${nameField}=${quoteValue(plan.alertName)} ` +
    '| bin _time span=1d | stats count by _time | sort _time';

  return {
    spl,
    earliest: plan.earliest ? checkTime(plan.earliest, 'earliest') : `-${plan.days}d@d`,
    latest: plan.latest ? checkTime(plan.latest, 'latest') : 'now',
    count: 100,
  };
}
