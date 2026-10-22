import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { checkGeneratedSpl, toSplunkTime, withTimeWindow } from './spl-guard';

/**
 * Splunk over MCP: a requirement goes in as text, Splunk writes the SPL, Splunk runs it.
 *
 * Two tools, named as Splunk's MCP Server names them: `saia_generate_spl` (Text-to-SPL,
 * Splunk AI Assistant for SPL) and `splunk_run_query`. In development they are served
 * by MCP-Server/Splunk in mock mode; in production SPLUNK_MCP_URL points at Splunk's own
 * MCP server and nothing here changes. No model on this side calls them — the backend
 * does, one requirement at a time.
 *
 * Between the two calls the generated SPL is checked (spl-guard): read-only, and the
 * alert's window added if the SPL did not set one. Which indexes it may read is the
 * Splunk role's business.
 */

/** What stage 1 stored for one requirement. */
export interface SplunkQuestion {
  requirement: string;
  index?: string;
  sourcetype?: string;
  /** Where the alert itself came from; said when the requirement is not aimed anywhere. */
  alertIndex?: string;
  alertSourcetype?: string;
  /** Details from the alert the requirements agent listed: device, source, user, user_agent, ... */
  context?: Record<string, string>;
  /** Which field each value sits in here, from the catalogue. */
  fieldHints?: Array<{ value: string; fields: string[] }>;
  /** The indicator and its fields, on lookups the backend planned itself (no fieldHints). */
  indicator?: string;
  fields?: string[];
  /** A playbook's own search: field=value pairs, already this estate's field names. */
  filters?: Record<string, string>;
  /** A playbook's grouped count, fields already resolved. */
  summarise?: {
    group_by?: string[];
    metrics: Array<{ fn: string; field?: string }>;
    span?: string;
    sort?: string;
  };
  /** "How often has this alert fired": the alert's name. */
  frequencyOf?: string;
  earliest?: string;
  latest?: string;
}

/** A playbook's grouped count as one line: "count, dc(dstip) by dstip, dstport per 1h, sorted by -count". */
function describeSummary(s: NonNullable<SplunkQuestion['summarise']>): string {
  const metrics = (s.metrics ?? []).map((m) => (m.field ? `${m.fn}(${m.field})` : m.fn)).join(', ') || 'count';
  return [
    metrics,
    s.group_by?.length ? `by ${s.group_by.join(', ')}` : '',
    s.span ? `per ${s.span}` : '',
    s.sort ? `sorted by ${s.sort}` : '',
  ].filter(Boolean).join(' ');
}

export interface SplunkAnswer {
  /** The text that was sent to Text-to-SPL. */
  prompt: string;
  /** The SPL that ran, after the window was added. */
  spl: string;
  rows: Array<Record<string, unknown>>;
  count: number;
  /** The rows stopped at `limit`; there may be more. */
  capped: boolean;
  limit: number;
  /** The far end said it answered from mock data. */
  mock: boolean;
}

/** Text-to-SPL alone: what Splunk wrote for a question, and whether the guard would let it run. */
export interface SplunkDraft {
  /** The text that was sent to Text-to-SPL. */
  prompt: string;
  /** The SPL as Text-to-SPL returned it. */
  generated: string;
  /** What would run: the guard passed it, with the window added. */
  spl?: string;
  /** Why the guard would not run it. */
  refused?: string;
}

export interface SplunkSession {
  /** The argument of the Text-to-SPL tool the request is sent in, as read from its schema. */
  promptArg: string;
  ask(question: SplunkQuestion): Promise<SplunkAnswer>;
  /** Only the first half of ask: Text-to-SPL and the guard. Nothing is searched. */
  generate(question: SplunkQuestion): Promise<SplunkDraft>;
  close(): Promise<void>;
}

// Whole events do not fit a small model's context: keep the fields that carry
// meaning plus a bounded slice of _raw. `host` and `source` on forwarded syslog
// name the forwarder, not the machine the alert is about.
const MAX_RAW_CHARS = 800;
const DROPPED_FIELDS = new Set([
  '_bkt', '_cd', '_indextime', '_serial', '_si', '_sourcetype', '_kv',
  'linecount', 'punct', 'splunk_server', 'eventtype', 'tag', 'timestamp', 'host', 'source',
]);

function trimRow(row: Record<string, unknown>): Record<string, unknown> {
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (DROPPED_FIELDS.has(key)) continue;
    trimmed[key] =
      key === '_raw' && typeof value === 'string' && value.length > MAX_RAW_CHARS
        ? `${value.slice(0, MAX_RAW_CHARS)}… [${value.length - MAX_RAW_CHARS} chars truncated]`
        : value;
  }
  return trimmed;
}

/** A tool's answer as data: structured content, else the text parsed as JSON, else the text. */
function payloadOf(result: any, tool: string): any {
  const text = (result?.content ?? [])
    .filter((c: any) => c?.type === 'text')
    .map((c: any) => c.text)
    .join('\n');
  if (result?.isError) throw new Error(`${tool}: ${text || 'the tool reported an error'}`);
  if (result?.structuredContent) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The SPL in what Text-to-SPL answered — a field, a fenced block, or the first line that is one. */
function splOf(payload: any): string {
  if (payload && typeof payload === 'object') {
    const found = payload.spl ?? payload.query ?? payload.search;
    if (typeof found === 'string') return found.trim();
  }
  const text = String(payload ?? '');
  const fenced = /```(?:spl|splunk)?\s*\n([\s\S]*?)```/i.exec(text);
  if (fenced) return fenced[1].trim();
  const line = text.split('\n').map((l) => l.trim()).find((l) => /^(search\s|index\s*=|\|)/i.test(l));
  return (line ?? '').trim();
}

function rowsOf(payload: any): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

@Injectable()
export class SplunkMcpService {
  private readonly logger = new Logger(SplunkMcpService.name);

  constructor(private readonly config: ConfigService) {}

  /** The endpoint, accepting a bare base URL and adding the path Splunk serves MCP at. */
  private endpoint(): URL {
    const url = new URL(this.config.get<string>('splunk.mcpUrl'));
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/services/mcp';
    return url;
  }

  /**
   * The prompt Text-to-SPL gets: the question, the details from the alert it is
   * about, where to look, which field each value sits in here, and when.
   *
   *   What else did 45.83.122.9 touch in the 24 hours around the alert.
   *   Details from the alert:
   *   - source: 45.83.122.9
   *   - device: FGT-01
   *   Search index=main sourcetype=fortigate
   *   Field names in this data: 45.83.122.9 is in srcip or dstip; FGT-01 is in devname. Use these field names.
   *   Time range: earliest=1790831054 latest=1790917454
   *
   * The details and the field names are what Text-to-SPL cannot know on its own:
   * which device and which kind of event the question is about, and that this
   * estate says `srcip` where CIM says `src_ip`.
   */
  promptFor(q: SplunkQuestion): { prompt: string; earliest: string; latest: string } {
    const earliest = toSplunkTime(q.earliest, '-24h');
    const latest = toSplunkTime(q.latest, 'now');
    const scope = (index?: string, sourcetype?: string) =>
      [index && `index=${index}`, sourcetype && `sourcetype=${sourcetype}`].filter(Boolean).join(' ');
    const where = scope(q.index, q.sourcetype);
    const from = scope(q.alertIndex, q.alertSourcetype);

    const lines = [`${q.requirement.replace(/[.\s]+$/, '')}.`];
    const details = Object.entries(q.context ?? {});
    if (details.length) {
      lines.push('Details from the alert:', ...details.map(([key, value]) => `- ${key}: ${value}`));
    }
    if (q.frequencyOf) {
      // The alert's own index is the wrong place to count alerts in.
      const { alertIndex, alertNameField } = this.config.get('splunk');
      lines.push(`Fired alerts are in index=${alertIndex}; the alert name is in the field ${alertNameField}.`);
    } else if (where) lines.push(`Search ${where}`);
    else if (from) lines.push(`The alert came from ${from}`);
    const filters = Object.entries(q.filters ?? {});
    if (filters.length) lines.push(`Only events where ${filters.map(([f, v]) => `${f}="${v}"`).join(' and ')}.`);
    if (q.summarise) lines.push(`Summarise: ${describeSummary(q.summarise)}.`);
    // Lookups the backend planned itself carry the indicator's fields, not hints.
    const hints = (
      q.fieldHints?.length
        ? q.fieldHints
        : q.indicator && q.fields?.length ? [{ value: q.indicator, fields: q.fields }] : []
    ).filter((h) => h.value && h.fields?.length);
    if (hints.length) {
      lines.push(
        `Field names in this data: ${hints.map((h) => `${h.value} is in ${h.fields.join(' or ')}`).join('; ')}. ` +
          'Use these field names.',
      );
    }
    // Values last and unpunctuated: a trailing full stop read as part of the time
    // or the index name is a search for something that does not exist.
    lines.push(`Time range: earliest=${earliest} latest=${latest}`);
    return { prompt: lines.join('\n'), earliest, latest };
  }

  async connect(): Promise<SplunkSession> {
    const { token, timeoutMs, generateTool, generateArg, queryTool, maxCount } =
      this.config.get('splunk');
    const url = this.endpoint();
    const client = new Client({ name: 'soc-backend', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    });
    try {
      await client.connect(transport);
    } catch (err: any) {
      throw new Error(`cannot connect to Splunk's MCP server at ${url.href}: ${err?.message ?? err}`);
    }

    // The argument Text-to-SPL takes the request in, read from the tool itself:
    // whatever Splunk names it, this does not need a release to follow.
    const tools = (await client.listTools()).tools;
    const generate = tools.find((t) => t.name === generateTool);
    const run = tools.find((t) => t.name === queryTool);
    if (!generate || !run) {
      await client.close();
      const missing = [!generate && generateTool, !run && queryTool].filter(Boolean).join(', ');
      throw new Error(
        `Splunk's MCP server has no ${missing}. Text-to-SPL needs Splunk AI Assistant for SPL ` +
          'installed and its tools enabled in the MCP Server app.',
      );
    }
    const props = Object.entries((generate.inputSchema?.properties ?? {}) as Record<string, any>);
    const required = (generate.inputSchema?.required ?? []) as string[];
    const promptArg =
      generateArg ||
      props.find(([name, schema]) => required.includes(name) && schema?.type === 'string')?.[0] ||
      props.find(([, schema]) => schema?.type === 'string')?.[0];
    if (!promptArg) {
      await client.close();
      throw new Error(`cannot tell which argument of ${generateTool} takes the request; set SPLUNK_MCP_GENERATE_ARG`);
    }

    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }).then((r) => payloadOf(r, name));

    return {
      promptArg,
      ask: async (q: SplunkQuestion): Promise<SplunkAnswer> => {
        const { prompt, earliest, latest } = this.promptFor(q);
        const generated = splOf(await call(generateTool, { [promptArg]: prompt }));
        if (!generated) throw new Error(`${generateTool} returned no SPL for: ${prompt}`);
        const spl = checkGeneratedSpl(withTimeWindow(generated, earliest, latest));

        const ran = await call(queryTool, { query: spl });
        const all = rowsOf(ran);
        const limit = maxCount;
        const rows = all.slice(0, limit).map(trimRow);
        this.logger.log(`ran ${rows.length} row(s) for "${q.requirement.slice(0, 60)}": ${spl}`);
        return {
          prompt,
          spl,
          rows,
          count: rows.length,
          capped: all.length >= limit,
          limit,
          mock: ran?.mock === true,
        };
      },
      generate: async (q: SplunkQuestion): Promise<SplunkDraft> => {
        const { prompt, earliest, latest } = this.promptFor(q);
        const generated = splOf(await call(generateTool, { [promptArg]: prompt }));
        if (!generated) throw new Error(`${generateTool} returned no SPL for: ${prompt}`);
        try {
          return { prompt, generated, spl: checkGeneratedSpl(withTimeWindow(generated, earliest, latest)) };
        } catch (err: any) {
          return { prompt, generated, refused: err?.message ?? String(err) };
        }
      },
      close: () => client.close(),
    };
  }

  /** The answer as an analyst reads it: what ran, how much came back, the rows. */
  render(a: SplunkAnswer): string {
    const head =
      `Splunk ran: ${a.spl}\n` +
      `${a.capped ? `At least ${a.count}` : a.count} row(s).` +
      (a.capped ? ` Stopped at ${a.limit}; there may be more.` : '') +
      (a.mock ? '\nMOCK DATA from the development connector — not real Splunk results.' : '');
    if (a.count === 0) return `${head}\nNothing matched in that window.`;
    const lines = a.rows.map(
      (row) =>
        '- ' +
        Object.entries(row)
          .filter(([k, v]) => v !== null && v !== '' && k !== '_raw')
          .map(([k, v]) => `${k}=${String(v)}`)
          .join('  '),
    );
    return [head, ...lines].join('\n');
  }
}
