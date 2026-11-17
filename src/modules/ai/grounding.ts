/**
 * Holding the model to the playbook.
 *
 * The playbook is shown to every agent as numbered passages, each with a tag —
 * [PB:true], [PB:false], [PB:step 2] — and the agent is told to cite the tag of
 * every statement it takes from the playbook (PlaybookService.render). This
 * module is the other half: it reads the reply and checks the citations are
 * real, that a true/false-positive verdict rests on the playbook's own criteria,
 * and that anything quoted as the playbook is in the playbook.
 *
 * It cannot tell whether a sentence without a tag was invented — no parser can —
 * but it can catch the failures that matter most and that a small model makes
 * most: a verdict with no criteria behind it, a verdict where no playbook exists,
 * a step number that is not there, and "criteria" written from general knowledge
 * and presented as the runbook's. What it finds goes back to the agent once
 * (correctionPrompt), and is stored on the job either way, so the analyst sees
 * which answers held to the playbook.
 *
 * Pure functions, no Nest: PlaybookService renders with `passages`, and both
 * processors check with `checkGrounding`.
 */

/** The playbook fields this needs. Matches PlaybookService's Playbook, without importing it. */
export interface GroundingPlaybook {
  alert_name?: string;
  use_case_id?: string;
  rule_description?: string;
  true_condition?: string;
  false_condition?: string;
  work_around?: string;
  steps?: string[];
  detection_spl?: string;
  target_audience?: string;
  contact?: string;
}

export interface GroundingMatch {
  matched: boolean;
  how?: string;
  playbook?: GroundingPlaybook;
}

/** One citable part of the playbook: `[PB:step 2]` and the text it stands for. */
export interface Passage {
  /** As cited, without brackets: "PB:true", "PB:step 2". */
  id: string;
  label: string;
  text: string;
}

export interface GroundingReport {
  /** Nothing below went wrong. */
  ok: boolean;
  /** Whether a playbook was shown at all. */
  playbook: boolean;
  /** The valid citations, in the order first used. */
  cited: string[];
  /** Tags that look like citations and name nothing the playbook has. */
  unknownCitations: string[];
  /** The verdict(s) the reply asserts, if any. */
  verdicts: Array<'true_positive' | 'false_positive'>;
  /** A verdict was asserted and [PB:true] or [PB:false] was cited for it. */
  verdictCited: boolean;
  /** Text quoted beside a [PB:...] tag that the playbook does not contain. */
  unsupportedQuotes: string[];
  /** Each problem, in words — what the correction prompt and the job page show. */
  problems: string[];
  /** Set by the caller: the first reply failed and the agent was asked again. */
  retried?: boolean;
}

const MAX_STEPS = 30;
const MIN_QUOTE_CHARS = 15;

/** work_around as steps, for an AI service that predates `steps`. Same rule: one line, one step. */
export function stepsOf(p: GroundingPlaybook): string[] {
  if (Array.isArray(p.steps)) return p.steps;
  return (p.work_around ?? '')
    .split('\n')
    .map((l) => l.trim().replace(/^(?:(?:step\s*)?\d+\s*[.):-]|[-*•▪●◦])(?=\s)\s*/i, '').trim())
    .filter(Boolean)
    .slice(0, MAX_STEPS);
}

/** The playbook as the passages an agent may cite, in the order it is shown them. */
export function passages(p: GroundingPlaybook | undefined): Passage[] {
  if (!p) return [];
  const out: Passage[] = [];
  if (p.rule_description) out.push({ id: 'PB:description', label: 'What it detects', text: p.rule_description });
  if (p.true_condition) out.push({ id: 'PB:true', label: 'TRUE POSITIVE when', text: p.true_condition });
  if (p.false_condition) out.push({ id: 'PB:false', label: 'FALSE POSITIVE when', text: p.false_condition });
  stepsOf(p).forEach((text, i) => out.push({ id: `PB:step ${i + 1}`, label: `Step ${i + 1}`, text }));
  const escalate = [p.target_audience, p.contact].filter(Boolean).join(' — ');
  if (escalate) out.push({ id: 'PB:contact', label: 'Escalate to', text: escalate });
  if (p.detection_spl) {
    out.push({
      id: 'PB:spl',
      label: 'The detection rule (SPL, for reference — it is not run)',
      text: p.detection_spl,
    });
  }
  return out;
}

// [PB:true], [ PB : step 2 ], [PB:step2], [pb:False]
const CITATION = /\[\s*PB\s*:\s*([a-z]+)\s*(\d+)?\s*\]/gi;
// "is a true positive", "likely false positive", "appears to be a true-positive"
const ASSERTED =
  /\b(?:is|as|be|likely|probably|possibly|appears?\s+to\s+be|seems?\s+to\s+be|confirmed|consistent\s+with)\s+(?:an?\s+|the\s+)?(?:likely\s+|probable\s+)?(true|false)[\s-]+positive\b/gi;
// "Verdict: True Positive", "**Assessment** - false positive", "Verdict: TP"
const LABELLED =
  /\b(?:verdict|assessment|classification|conclusion|disposition)\b[^\n]{0,20}?[:\-–]\s*[*_`]*\s*(?:(true|false)[\s-]+positive|(tp|fp))\b/gi;
const QUOTE = /["“]([^"“”\n]{1,400})["”]/g;

const normal = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9.:/@\\-]+/g, ' ').replace(/\s+/g, ' ').trim();

function verdictsIn(reply: string): Array<'true_positive' | 'false_positive'> {
  const found = new Set<'true_positive' | 'false_positive'>();
  for (const m of reply.matchAll(ASSERTED)) found.add(m[1].toLowerCase() === 'true' ? 'true_positive' : 'false_positive');
  for (const m of reply.matchAll(LABELLED)) {
    const word = (m[1] ?? m[2] ?? '').toLowerCase();
    found.add(word === 'true' || word === 'tp' ? 'true_positive' : 'false_positive');
  }
  return [...found];
}

/**
 * How well a reply held to the playbook it was shown.
 *
 * `match` is what the agent saw: null, unmatched, or a playbook. With no
 * playbook, any verdict and any [PB:...] tag is a problem — there was nothing
 * to rest either on.
 */
export function checkGrounding(reply: string, match: GroundingMatch | null | undefined): GroundingReport {
  const text = reply ?? '';
  const shown = match?.matched ? passages(match.playbook) : [];
  const valid = new Map(shown.map((p) => [p.id.toLowerCase(), p]));

  const cited: string[] = [];
  const unknown: string[] = [];
  const problems: string[] = [];

  for (const m of text.matchAll(CITATION)) {
    const id = `PB:${m[1].toLowerCase()}${m[2] ? ` ${Number(m[2])}` : ''}`;
    const known = valid.has(id.toLowerCase());
    const list = known ? cited : unknown;
    if (!list.includes(id)) list.push(id);
  }

  const verdicts = verdictsIn(text);
  const verdictCited = verdicts.length > 0 && (cited.includes('PB:true') || cited.includes('PB:false'));

  // A quotation on a line that cites the playbook is a claim about what the
  // playbook says. Checked against the playbook's text, normalised, so a
  // different quote mark or a trailing full stop does not count against it.
  const corpus = normal(shown.map((p) => p.text).join('\n'));
  const unsupportedQuotes: string[] = [];
  if (shown.length > 0) {
    for (const line of text.split('\n')) {
      if (!/\[\s*PB\s*:/i.test(line)) continue;
      for (const q of line.matchAll(QUOTE)) {
        const quote = q[1].trim();
        if (quote.length < MIN_QUOTE_CHARS) continue;
        // A sentence quoted whole carries its full stop; the passage may not.
        if (!corpus.includes(normal(quote).replace(/[.:\-\s]+$/, ''))) unsupportedQuotes.push(quote);
      }
    }
  }

  const readable = (v: string) => v.replace('_', ' ');
  if (!match?.matched) {
    if (verdicts.length > 0) {
      problems.push(
        `It gives a verdict (${verdicts.map(readable).join(' and ')}), but no playbook covers this ` +
          'alert, so there are no written criteria to judge it by. Leave the verdict to the analyst.',
      );
    }
    if (unknown.length > 0) {
      problems.push(`It cites ${unknown.map((c) => `[${c}]`).join(', ')}, but no playbook was given.`);
    }
  } else {
    if (unknown.length > 0) {
      problems.push(
        `It cites ${unknown.map((c) => `[${c}]`).join(', ')}, which this playbook does not have ` +
          `(it has: ${shown.map((p) => `[${p.id}]`).join(', ') || 'nothing citable'}).`,
      );
    }
    if (verdicts.length > 1) {
      problems.push('It says both true positive and false positive.');
    }
    if (verdicts.length > 0 && !valid.has('pb:true') && !valid.has('pb:false')) {
      problems.push(
        `It gives a verdict (${verdicts.map(readable).join(' and ')}), but this playbook defines no ` +
          'true or false condition to judge it by. Leave the verdict to the analyst.',
      );
    } else if (verdicts.length > 0 && !verdictCited) {
      problems.push(
        `It gives a verdict (${verdicts.map(readable).join(' and ')}) without citing the condition it ` +
          'rests on. Cite [PB:true] or [PB:false] for the verdict.',
      );
    }
    for (const q of unsupportedQuotes) {
      problems.push(`It quotes "${q.slice(0, 120)}" as the playbook, and the playbook does not say that.`);
    }
  }

  return {
    ok: problems.length === 0,
    playbook: Boolean(match?.matched),
    cited,
    unknownCitations: unknown,
    verdicts,
    verdictCited,
    unsupportedQuotes,
    problems,
  };
}

/**
 * The same prompt, the reply that failed, and what was wrong with it.
 *
 * Asked once. A second failure is kept and flagged rather than asked a third
 * time: the analyst is waiting, and a model that misreads the rules twice is
 * not going to be argued into them.
 */
export function correctionPrompt(prompt: string, reply: string, report: GroundingReport): string {
  return [
    prompt,
    '',
    '--- YOUR PREVIOUS ANSWER ---',
    reply.trim(),
    '--- END OF PREVIOUS ANSWER ---',
    '',
    '--- CORRECTION ---',
    'Your previous answer broke the playbook rules:',
    ...report.problems.map((p) => `- ${p}`),
    '',
    'Write the whole answer again. Take criteria and steps only from the playbook passages above, ' +
      'cite each by its [PB:...] tag, and where the playbook does not cover something, say ' +
      '"The playbook does not say." Do not mention this correction.',
    '--- END OF CORRECTION ---',
  ].join('\n');
}

/** The better of two attempts: fewer problems, the later one on a tie. */
export function better<T extends { report: GroundingReport }>(first: T, second: T): T {
  return second.report.problems.length <= first.report.problems.length ? second : first;
}
