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
export function requirementsFormat(limit: number): string {
  return [
    '--- ANSWER FORMAT ---',
    `List what to ask Splunk, at most ${limit} items. For each one write:`,
    '- the question, one line, naming the value it is about',
    '- then, one per line, every detail from the alert above that helps find it, as `key: value`',
    '  (keys such as: device, source, destination, domain, url, user, user_agent, host,',
    '  hash, process, signature, type, action). Copy each value exactly as it appears',
    '  above. Leave out a detail the alert does not have — never invent one.',
    '',
    'Example of the shape (the values here are not from this alert):',
    '1. What else did 203.0.113.7 touch in the 24 hours around the alert',
    '   source: 203.0.113.7',
    '   device: fw-edge-01',
    '   type: traffic',
    '   user: a.example',
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
  'region', 'service', 'technique', 'tactic', 'severity', 'category',
]);

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
  return value ? { key, value } : null;
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
): ModelRequirement[] {
  const text = (reply ?? '').trim();
  if (!text) return [];

  const header = NEEDED_HEADER.exec(text);
  const body = header ? text.slice(header.index + header[0].length) : text;
  const haystack = shown?.toLowerCase();

  // Longest first, so "10.1.100.44" is preferred over a shorter value that
  // happens to be a substring of it.
  const byLength = [...known].sort((a, b) => b.value.length - a.value.length);

  type Draft = { requirement: string; context: Record<string, string>; dropped: string[] };
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  // The question the detail lines below it belong to. Unset after a skipped line,
  // so details under a duplicate or a `none` do not land on the question before.
  let current: Draft | undefined;

  for (const line of body.split('\n')) {
    if (!line.trim()) continue;

    const detail = current ? detailOf(line) : null;
    const indented = /^\s+\S/.test(line);
    if (current && detail && (indented || !BULLET.test(line) || KNOWN_KEYS.has(detail.key))) {
      if (Object.keys(current.context).length >= MAX_DETAILS) continue;
      const real = !haystack || (detail.value.length >= 2 && haystack.includes(detail.value.toLowerCase()));
      if (real) current.context[detail.key] ??= detail.value;
      else current.dropped.push(`${detail.key}: ${detail.value}`);
      continue;
    }

    const bullet = BULLET.exec(line);
    if (!bullet) continue;
    current = undefined;
    const item = line.slice(bullet[0].length).trim().replace(/[.;]+$/, '');
    if (!item || NOTHING.test(item)) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    current = { requirement: item, context: {}, dropped: [] };
    drafts.push(current);
  }

  return drafts.slice(0, limit).map(({ requirement, context, dropped }) => {
    // The question names the value it is about; failing that, a detail does.
    const hit =
      byLength.find((i) => requirement.includes(i.value)) ??
      byLength.find((i) => Object.values(context).some((v) => v.includes(i.value)));
    const details = {
      ...(Object.keys(context).length ? { context } : {}),
      ...(dropped.length ? { droppedContext: dropped } : {}),
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
