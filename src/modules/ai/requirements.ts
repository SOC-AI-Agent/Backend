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
}

const SUGGESTION_HEADER = /^[^\n]*={2,}\s*suggestion\s*={2,}[^\n]*$/im;
// Tolerated, no longer asked for: the requirements agent used to share a reply
// with the suggestion, under this header.
const NEEDED_HEADER = /^[^\n]*needed\s+from\s+splunk[^\n]*$/im;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
const NOTHING = /^(?:none|n\/?a|nothing(?:\s+further)?|no(?:ne)?\s+needed)\.?$/i;

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

/**
 * The requirements agent's reply, with each line bound to an extracted value.
 *
 * Forgiving about shape on purpose. The model numbers the bullets, writes a
 * header nobody asked for, and appends `- none` after four real lines because the
 * instruction to write `none` when there is nothing was the last thing it read.
 * None of that should cost the analyst the list.
 */
export function parseRequirements(
  reply: string,
  known: KnownIndicator[],
  limit = 5,
): ModelRequirement[] {
  const text = (reply ?? '').trim();
  if (!text) return [];

  const header = NEEDED_HEADER.exec(text);
  const body = header ? text.slice(header.index + header[0].length) : text;

  // Longest first, so "10.1.100.44" is preferred over a shorter value that
  // happens to be a substring of it.
  const byLength = [...known].sort((a, b) => b.value.length - a.value.length);

  const requirements: ModelRequirement[] = [];
  const seen = new Set<string>();

  for (const line of body.split('\n')) {
    const bullet = BULLET.exec(line);
    if (!bullet) continue;
    const item = line.slice(bullet[0].length).trim().replace(/[.;]+$/, '');
    if (!item || NOTHING.test(item)) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const hit = byLength.find((i) => item.includes(i.value));
    requirements.push(
      hit
        ? { requirement: item, indicator: hit.value, indicatorType: hit.type }
        : {
            requirement: item,
            unmatched:
              'this names no value that was extracted from the alert, so there is ' +
              'nothing to aim a search at',
          },
    );
    if (requirements.length >= limit) break;
  }

  return requirements;
}
