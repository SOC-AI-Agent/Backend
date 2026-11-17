/**
 * Turning what the model asked for into something that can actually be run.
 *
 * The requirements agent decides what is worth knowing — that is judgement, and
 * it is the part of this pipeline a model is for. It does not decide where to look: which
 * index, which sourcetype, which of a hundred field names carries a source IP
 * here. That has one right answer, the catalogue holds it, and a 7B model
 * guessing at it was the original bug.
 *
 * The join between the two is this: every requirement must name a value that
 * was extracted from the alert. Those values already have a type, because the
 * extractor assigned one, so matching the line against them gives the type
 * without parsing English. A line naming nothing we extracted is kept and
 * flagged rather than run — it is either about something outside the alert, or
 * the model invented it, and both are worth an analyst seeing rather than a
 * search being aimed at a value that was never there.
 */

export interface KnownIndicator {
  type: string;
  value: string;
  source: string;
}

export interface ModelRequirement {
  requirement: string;
  /** The extracted value this line is about, when it names one. */
  indicator?: string;
  indicatorType?: string;
  /** Why it could not be aimed, when it could not. */
  unmatched?: string;
  /**
   * Details from the alert the agent listed under the question — `device`,
   * `source`, `user`, `user_agent`, ... — for Text-to-SPL to work from. Only
   * values that appear in what the agent was shown are kept.
   */
  context?: Record<string, string>;
  /** Details the agent wrote that appear nowhere in what it was shown, as `key: value`. */
  droppedContext?: string[];
  /**
   * The playbook step (1-based, [PB:step N]) this question serves, when the
   * agent named one that exists. These run first: the runbook says to look.
   */
  playbookStep?: number;
}

/**
 * How the requirements agent is asked to answer. Sent at the end of every
 * requirements prompt (buildRequirementsPrompt), so the shape does not depend on
 * what the agent's system prompt in Agent-Server says, and kept here beside the
 * parser that reads it.
 *
 * The details under each question are what Text-to-SPL gets to work from: a
 * device name, a user agent or a type tells it which data and which fields the
 * question is about far better than the question alone.
 */
export function requirementsFormat(limit: number, steps = 0): string {
  const fromPlaybook =
    steps > 0
      ? [
          `Start from the playbook. For each of its steps ([PB:step 1] to [PB:step ${steps}]) that needs`,
          'data from Splunk to carry out, ask the question that step needs answered, and put',
          '`step: N` under it with that step\'s number. Only then add what else the evidence needs,',
          'without a step line. Never give a step number the playbook does not have.',
          '',
        ]
      : [];
  return [
    '--- ANSWER FORMAT ---',
    ...fromPlaybook,
    `List what to ask Splunk, at most ${limit} distinct items. For each one write:`,
    '- the question, one line, naming the exact indicator value it is about (do not ask multiple questions about the same value unless narrowing by a different detail)',
    '- then, one per line, only the detail(s) from the alert above needed to scope that search, as `key: value`',
    '  (keys such as: device, source, destination, domain, url, user, user_agent, host,',
    '  hash, process, signature, type, action). Copy each value verbatim as a single value',
    '  from the alert above. Never write `-`, `none`, `N/A`, or invent a value.',
    '',
    'Example of the shape (the values here are not from this alert):',
    '1. What else did 203.0.113.7 touch in the 24 hours around the alert',
    ...(steps > 0 ? ['   step: 2'] : []),
    '   source: 203.0.113.7',
    '   device: fw-edge-01',
    '',
    'If nothing needs asking, write: none',
  ].join('\n');
}

const SUGGESTION_HEADER = /^[^\n]*={2,}\s*suggestion\s*={2,}[^\n]*$/im;
// Tolerated, no longer asked for: the requirements agent used to share a reply
// with the suggestion, under this header.
const NEEDED_HEADER = /^[^\n]*needed\s+from\s+splunk[^\n]*$/im;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
const NOTHING = /^(?:none|n\/?a|nothing(?:\s+further)?|no(?:ne)?\s+needed)\.?$/i;
// A detail line under a question: `device: FGT-01`, `- user = j.smith`. The key is
// a label of at most three words with no dots, so a question such as
// "Check 10.1.100.44: what else did it reach" is never mistaken for one.
const DETAIL = /^\s*(?:[-*•]\s+)?\**([A-Za-z][A-Za-z0-9_ -]{0,29}?)\**\s*[:=]\s*(.+?)\s*$/;
const MAX_DETAILS = 10;
const MAX_DETAIL_CHARS = 200;
// Keys that are always a detail, even on a flush-left bullet. Any other key counts
// only when the line is indented or has no bullet: "- Logins by user: j.smith" at
// the margin is more likely the next question than a detail of the last one.
const KNOWN_KEYS = new Set([
  'device', 'source', 'src', 'src_ip', 'source_ip', 'destination', 'dest', 'dst', 'dest_ip',
  'ip', 'port', 'src_port', 'dest_port', 'protocol', 'domain', 'url', 'user', 'username',
  'user_name', 'account', 'user_agent', 'useragent', 'host', 'hostname', 'hash', 'md5',
  'sha1', 'sha256', 'file', 'file_name', 'process', 'command', 'signature', 'type',
  'action', 'app', 'application', 'email', 'sender', 'recipient', 'event', 'event_name',
  'region', 'service', 'technique', 'tactic', 'severity', 'category', 'step',
]);
// "[PB:step 2]" written into the question itself rather than under it.
const STEP_TAG = /\s*\[\s*PB\s*:\s*step\s*(\d+)\s*\]\s*/i;

export interface ParsedSuggestion {
  suggestion: string;
  /** The agent said nothing. */
  malformed: boolean;
}

/**
 * The suggestion agent's reply, as the analyst reads it.
 *
 * The reply is kept whole. A 7B model asked for three headed parts mostly
 * obliges, but it also writes `**== SUGGESTION ==**` above them from habit, and
 * losing or mangling the answer over a header would be the worse failure. So the
 * only thing removed is that header.
 */
export function parseSuggestion(reply: string): ParsedSuggestion {
  const text = (reply ?? '').trim();
  if (!text) return { suggestion: '', malformed: true };

  const header = SUGGESTION_HEADER.exec(text);
  const body = header ? text.slice(header.index + header[0].length).trim() : text;
  return { suggestion: body || text, malformed: false };
}

const PLACEHOLDER_DETAIL = /^(?:[-–—]+|none|n\/?a|null|unknown|not[_\s-]*(?:available|applicable|specified|present)|tbd|\?+)$/i;

/** `key: value` when the line is a detail, normalised; null when it is not one. */
function detailOf(line: string): { key: string; value: string } | null {
  const match = DETAIL.exec(line);
  if (!match) return null;
  const words = match[1].trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return null;
  const key = words.join('_').toLowerCase();
  const value = match[2]
    .trim()
    .replace(/^[`"'“”]+|[`"'“”]+$/g, '')
    .replace(/[.;,]+$/, '')
    .trim()
    .slice(0, MAX_DETAIL_CHARS);
  if (!value || PLACEHOLDER_DETAIL.test(value)) return null;
  return { key, value };
}

/**
 * The requirements agent's reply, with each line bound to an extracted value.
 *
 * Forgiving about shape on purpose. The model numbers the bullets, writes a
 * header nobody asked for, and appends `- none` after four real lines because the
 * instruction to write `none` when there is nothing was the last thing it read.
 * None of that should cost the analyst the list.
 *
 * `shown` is everything the agent was given (the alert, ThreatQ, the playbook, the
 * suggestion). A detail is kept only when its value appears there: a small model
 * fills a template with plausible values as readily as with real ones, and a
 * made-up device name sent to Text-to-SPL is a search for something that does not
 * exist. What was dropped is kept beside the requirement, so it can be seen.
 */
export function parseRequirements(
  reply: string,
  known: KnownIndicator[],
  limit = 5,
  shown?: string,
  /** How many steps the playbook it was shown has; a `step: N` outside 1..steps is dropped. */
  steps = 0,
): ModelRequirement[] {
  const text = (reply ?? '').trim();
  if (!text) return [];

  const header = NEEDED_HEADER.exec(text);
  const body = header ? text.slice(header.index + header[0].length) : text;
  const haystack = shown?.toLowerCase();

  // Specific indicators (ip, hash, user, url, process, service, domain) beat
  // ambient host/device names when a question mentions both ("What other activity
  // has the user vanitas performed on KBTG-Bootcamp"); within the same tier,
  // longest first so "10.1.100.44" beats a shorter substring.
  const priority = (t: string) => (t === 'host' ? 1 : 0);
  const byLength = [...known].sort(
    (a, b) => priority(a.type) - priority(b.type) || b.value.length - a.value.length,
  );

  type Draft = { requirement: string; context: Record<string, string>; dropped: string[]; step?: number };
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  // The question the detail lines below it belong to. Unset after a skipped line,
  // so details under a duplicate or a `none` do not land on the question before.
  let current: Draft | undefined;
  // A step is a number, and "2" is in any prompt: checked against the playbook's
  // step count, not against what the agent was shown.
  const takeStep = (draft: Draft, raw: string) => {
    const n = Number.parseInt(raw.replace(/^\D+/, ''), 10);
    if (Number.isInteger(n) && n >= 1 && n <= steps) draft.step ??= n;
    else draft.dropped.push(`step: ${raw} (the playbook has ${steps ? `steps 1-${steps}` : 'no steps'})`);
  };

  for (const line of body.split('\n')) {
    if (!line.trim()) continue;

    const detail = current ? detailOf(line) : null;
    const indented = /^\s+\S/.test(line);
    if (current && detail && (indented || !BULLET.test(line) || KNOWN_KEYS.has(detail.key))) {
      if (detail.key === 'step') {
        takeStep(current, detail.value);
        continue;
      }
      if (Object.keys(current.context).length >= MAX_DETAILS) continue;
      const real = !haystack || (detail.value.length >= 2 && haystack.includes(detail.value.toLowerCase()));
      if (real) current.context[detail.key] ??= detail.value;
      else current.dropped.push(`${detail.key}: ${detail.value}`);
      continue;
    }

    const bullet = BULLET.exec(line);
    if (!bullet) continue;
    current = undefined;
    let item = line.slice(bullet[0].length).trim().replace(/[.;]+$/, '');
    const tag = STEP_TAG.exec(item);
    if (tag) item = item.replace(STEP_TAG, ' ').trim().replace(/[.;:,]+$/, '');
    if (!item || NOTHING.test(item)) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    current = { requirement: item, context: {}, dropped: [] };
    if (tag) takeStep(current, tag[1]);
    drafts.push(current);
  }

  return drafts.slice(0, limit).map(({ requirement, context, dropped, step }) => {
    // The question names the value it is about; failing that, a detail does.
    const hit =
      byLength.find((i) => requirement.includes(i.value)) ??
      byLength.find((i) => Object.values(context).some((v) => v.includes(i.value)));
    const details = {
      ...(Object.keys(context).length ? { context } : {}),
      ...(dropped.length ? { droppedContext: dropped } : {}),
      ...(step ? { playbookStep: step } : {}),
    };
    return hit
      ? { requirement, indicator: hit.value, indicatorType: hit.type, ...details }
      : {
          requirement,
          unmatched:
            'this names no value that was extracted from the alert, so there is ' +
            'nothing to aim a search at',
          ...details,
        };
  });
}
