/**
 * Turning what the model asked for into something that can actually be run.
 *
 * The model decides what is worth knowing — that is judgement, and it is the
 * part of this pipeline a model is for. It does not decide where to look: which
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

const NEEDED_HEADER = /^[^\n]*needed\s+from\s+splunk[^\n]*$/im;
const SUGGESTION_HEADER = /^[^\n]*={2,}\s*suggestion\s*={2,}[^\n]*$/im;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
const NOTHING = /^(?:none|n\/?a|nothing(?:\s+further)?|no(?:ne)?\s+needed)\.?$/i;

export interface ParsedReply {
  suggestion: string;
  requirements: ModelRequirement[];
  /** The model did not answer in the shape it was asked for. */
  malformed: boolean;
}

/**
 * Split the reply, and bind each requirement to an extracted value.
 *
 * Forgiving about shape on purpose. A 7B model asked for two headed sections
 * mostly obliges, but it also writes `**== SUGGESTION ==**`, numbers the
 * bullets, and appends `- none` after four real lines because the instruction
 * to write `none` when there is nothing was the last thing it read. None of
 * that should cost the analyst the answer.
 */
export function parseReply(
  reply: string,
  known: KnownIndicator[],
  limit = 5,
): ParsedReply {
  const text = (reply ?? '').trim();
  if (!text) return { suggestion: '', requirements: [], malformed: true };

  const split = NEEDED_HEADER.exec(text);
  if (!split) {
    // The reply is still the analyst's answer, so it is kept whole. Losing it
    // to a formatting miss would be the worse failure.
    return { suggestion: text, requirements: [], malformed: true };
  }

  let suggestion = text.slice(0, split.index).trim();
  const header = SUGGESTION_HEADER.exec(suggestion);
  if (header) suggestion = suggestion.slice(header.index + header[0].length).trim();

  // Longest first, so "10.1.100.44" is preferred over a shorter value that
  // happens to be a substring of it.
  const byLength = [...known].sort((a, b) => b.value.length - a.value.length);

  const requirements: ModelRequirement[] = [];
  const seen = new Set<string>();

  for (const line of text.slice(split.index + split[0].length).split('\n')) {
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

  return { suggestion: suggestion || text, requirements, malformed: !suggestion };
}
