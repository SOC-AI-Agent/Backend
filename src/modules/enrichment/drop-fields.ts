/**
 * The alert with the fields that describe the search that raised it, rather
 * than the event, taken out.
 *
 * Only a JSON object carrying at least one of those fields is rewritten — an ES
 * notable, whose values Splunk sends as strings, so re-serialising changes
 * nothing that is kept. Anything else goes through exactly as sent.
 */
export function dropFields(rawLog: string, fields: string[]): string {
  if (fields.length === 0) return rawLog;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLog);
  } catch {
    return rawLog;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rawLog;

  const drop = new Set(fields);
  const entries = Object.entries(parsed);
  const kept = entries.filter(([key]) => !drop.has(key));
  return kept.length === entries.length ? rawLog : JSON.stringify(Object.fromEntries(kept));
}
