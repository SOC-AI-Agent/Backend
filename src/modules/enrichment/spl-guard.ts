/**
 * Checks on SPL the backend did not write.
 *
 * In the Splunk stage the search comes from Splunk's own Text-to-SPL
 * (saia_generate_spl), not from code here, and it is run against production data.
 * Splunk's MCP Server has guardrails of its own; this is the same idea checked on
 * this side first, so a generated `| delete` or `| outputlookup` is refused before
 * it is sent, whatever the far end would have done with it. The connector
 * (MCP-Server/Splunk spl.check_readonly) checks the same list.
 *
 * Which indexes a search may read is not checked here: that is the Splunk role's
 * job (srchIndexesAllowed on the backend's service account). A search that names
 * no index reads the role's default indexes.
 */

// Commands that write, delete, send data out or execute. A denylist, because
// generated SPL uses the whole read-only language (table, eval, where, timechart, ...).
// Splunk's own list of risky commands (SPL safeguards: collect, delete, dump, map,
// mcollect, meventcollect, outputcsv, outputlookup, run, runshellscript, script,
// sendalert, sendemail, tscollect), plus summaryindex (collect's alias), outputtext,
// rest, crawl and DB Connect's dbxquery/dbxoutput. Splunk's safeguard is only a
// warning in Splunk Web; a search sent over the API gets no such check, hence this.
// https://help.splunk.com/en/splunk-cloud-platform/administer/manage-users-and-security/10.5.2605/best-practices-for-splunk-platform-security/spl-safeguards-for-risky-commands
// The connector (MCP-Server/Splunk/spl.py FORBIDDEN_COMMANDS) keeps the same list.
const FORBIDDEN_COMMANDS = new Set([
  'delete', 'collect', 'mcollect', 'meventcollect', 'tscollect', 'summaryindex',
  'outputlookup', 'outputcsv', 'outputtext', 'sendemail', 'sendalert', 'script',
  'run', 'runshellscript', 'map', 'dump', 'rest', 'dbxquery', 'dbxoutput', 'crawl',
]);

const QUOTED = /"(?:[^"\\]|\\.)*"/g;
const MAX_LEN = 4000;

/** The search, if it is read-only. Throws with the reason otherwise. */
export function checkGeneratedSpl(spl: string): string {
  const query = (spl ?? '').trim();
  if (!query) throw new Error('Splunk returned no SPL');
  if (query.length > MAX_LEN) throw new Error(`the generated SPL is too long (${query.length} chars)`);

  const bare = query.replace(QUOTED, '""');
  if (bare.replace(/""/g, '').includes('"')) throw new Error('the generated SPL has an unbalanced quote');
  if (bare.includes('`')) throw new Error('the generated SPL uses a macro, and what it expands to cannot be checked');

  // Every command, including those inside a subsearch.
  for (const segment of bare.split(/[|[]/)) {
    const command = /^\s*([A-Za-z_]+)/.exec(segment)?.[1]?.toLowerCase();
    if (command && FORBIDDEN_COMMANDS.has(command)) {
      throw new Error(`the generated SPL uses '${command}', which is not allowed in a read-only search`);
    }
  }
  return query;
}

/**
 * A time for SPL's inline earliest=/latest=. They take relative times (-24h) or
 * epoch seconds, not the ISO 8601 the alert window is stored in.
 */
export function toSplunkTime(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const ms = Date.parse(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(ms) ? String(Math.floor(ms / 1000)) : value;
}

/**
 * The alert's window, put into a search that does not set its own.
 *
 * splunk_run_query takes only the SPL, so the window has to be in it; Text-to-SPL
 * is asked for it, and this is the fallback when it leaves it out. Only a search
 * that starts with `search` or `index=` is changed — one that opens with a
 * generating command (`| tstats ...`) is left as written.
 */
export function withTimeWindow(spl: string, earliest: string, latest: string): string {
  if (/\b(earliest|latest)\s*=/i.test(spl)) return spl;
  const window = `earliest=${earliest} latest=${latest}`;
  if (/^search\s/i.test(spl)) return spl.replace(/^search\s+/i, `search ${window} `);
  if (/^index\s*=/i.test(spl)) return `search ${window} ${spl}`;
  return spl;
}
