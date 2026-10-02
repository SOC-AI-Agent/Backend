/**
 * The two prompts that follow the suggestion, and the reading of what comes back.
 *
 * Both are pure functions of what the backend already holds — the rendered alert,
 * the suggestion, the search results — so they can be read, and tested, without a
 * model in the loop.
 */
import { LookupAnswer } from '../queue/lookup-job.payload';
import { requirementsFormat } from './requirements';

/**
 * What the requirements agent is shown: the alert as stage 1 saw it, plus the
 * suggestion already written, then the shape of the answer — each question with
 * the details from the alert that help find it (requirementsFormat). It starts
 * from what the suggestion says was not determined, so it is given that text and
 * not asked to work it out again.
 */
export function buildRequirementsPrompt(rendered: string, suggestion: string, limit = 5): string {
  return [
    rendered,
    '',
    '--- SUGGESTION ALREADY WRITTEN ---',
    suggestion,
    '--- END OF SUGGESTION ---',
    '',
    requirementsFormat(limit),
  ].join('\n');
}

/** Room for the results in a prompt that also carries the alert and the suggestion. */
export const RESULTS_BUDGET_CHARS = 7000;
const PER_RESULT_CHARS = 1800;

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n… [${text.length - max} more characters left out]`;

/**
 * One numbered block per requirement, in the order they ran.
 *
 * Numbered because the analysis cites them ([splunk 2]) and the page numbers the
 * same list, so a claim can be walked back to the search that made it. A result
 * that was not searched, or failed, is included and says so: an analysis that
 * never hears about a gap cannot report it.
 */
export function renderResults(answers: LookupAnswer[], budget = RESULTS_BUDGET_CHARS): string {
  const perResult = Math.min(PER_RESULT_CHARS, Math.max(400, Math.floor(budget / Math.max(answers.length, 1))));

  return answers
    .map((a, i) => {
      const where = [a.index, a.sourcetype].filter(Boolean).join('/');
      const lines = [
        `[splunk ${i + 1}] ${a.requirement}`,
        where || a.fields?.length
          ? `looked in: ${where || 'the whole estate'}${a.fields?.length ? `, fields ${a.fields.join(' / ')}` : ''}`
          : undefined,
        a.error ? `FAILED: ${a.error}` : cut(a.answer, perResult),
      ];
      return lines.filter(Boolean).join('\n');
    })
    .join('\n\n');
}

/** Alert, first reading, and the numbered results — in that order. */
export function buildConclusionPrompt(rendered: string, suggestion: string, answers: LookupAnswer[]): string {
  return [
    rendered,
    '',
    '--- FIRST READING (SUGGESTION) ---',
    suggestion,
    '--- END OF FIRST READING ---',
    '',
    '--- SPLUNK RESULTS ---',
    renderResults(answers),
    '--- END OF SPLUNK RESULTS ---',
  ].join('\n');
}

const HEADER = /^[^\n]*={2,}\s*(?:analysis|reading)\s*={2,}[^\n]*$/im;

/** The reply as the analyst reads it: kept whole, minus a header nobody asked for. */
export function parseConclusion(reply: string): string {
  const text = (reply ?? '').trim();
  const header = HEADER.exec(text);
  return (header ? text.slice(header.index + header[0].length).trim() : text) || text;
}
