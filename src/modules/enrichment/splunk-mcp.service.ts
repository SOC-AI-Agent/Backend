import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Splunk over MCP: a requirement goes in as stage 1 stored it, the answer comes back.
 *
 * Everything Splunk-shaped lives in the connector, MCP-Server/Splunk: the prompt
 * Text-to-SPL gets, Text-to-SPL itself, the read-only check, the search, and trimming
 * the rows for a small model. This is only the client — two tools, `splunk_lookup`
 * (write the SPL, check it, run it) and `splunk_text_to_spl` (the first half, nothing
 * searched). No model on this side calls them — the backend does, one requirement at
 * a time.
 *
 * Which Splunk answers is the connector's configuration, not the backend's: mock
 * events, a Splunk container, or the company's Splunk with Splunk AI Assistant.
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
  /** Who wrote the SPL: 'caller' (the SPL agent's draft), 'assistant' or 'template'. */
  writtenBy?: string;
  /** The rows as an analyst reads them: what ran, how much came back, the rows. */
  answer: string;
}

/** A requirement the connector could not answer. Carries the prompt it had built, when it got that far. */
export class SplunkLookupError extends Error {
  constructor(message: string, readonly prompt?: string, readonly spl?: string) {
    super(message);
  }
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
  /**
   * Throws SplunkLookupError when the requirement could not be answered. `written`
   * is an agent's reply to writerPrompt, as it came: the connector finds the SPL in
   * it, checks it and runs it instead of writing its own.
   */
  ask(question: SplunkQuestion, written?: string): Promise<SplunkAnswer>;
  /** What to show an agent that writes the SPL; null when the connector has no such tool. */
  writerPrompt(question: SplunkQuestion): Promise<string | null>;
  /** Only the first half of ask: Text-to-SPL and the guard. Nothing is searched. */
  generate(question: SplunkQuestion): Promise<SplunkDraft>;
  close(): Promise<void>;
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

@Injectable()
export class SplunkMcpService {
  private readonly logger = new Logger(SplunkMcpService.name);

  constructor(private readonly config: ConfigService) {}

  /** The endpoint, accepting a bare base URL and adding the path the connector serves MCP at. */
  private endpoint(): URL {
    const url = new URL(this.config.get<string>('splunk.mcpUrl'));
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/services/mcp';
    return url;
  }

  async connect(): Promise<SplunkSession> {
    const { token, timeoutMs, lookupTool, textToSplTool, promptTool } = this.config.get('splunk');
    const url = this.endpoint();
    const client = new Client({ name: 'soc-backend', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    });
    try {
      await client.connect(transport);
    } catch (err: any) {
      throw new Error(`cannot connect to the Splunk connector at ${url.href}: ${err?.message ?? err}`);
    }

    const tools = (await client.listTools()).tools.map((t) => t.name);
    const missing = [lookupTool, textToSplTool].filter((name) => !tools.includes(name));
    if (missing.length) {
      await client.close();
      throw new Error(
        `the MCP server at ${url.href} has no ${missing.join(', ')}. SPLUNK_MCP_URL must point at ` +
          "soc-mcp-splunk (MCP-Server/Splunk), not at Splunk's own MCP server — the connector is what talks to Splunk.",
      );
    }

    // The stored plan has nulls where stage 1 found nothing; the connector reads absent, not null.
    const call = (name: string, q: SplunkQuestion, written?: string) =>
      client
        .callTool(
          {
            name,
            arguments: {
              question: Object.fromEntries(Object.entries(q).filter(([, v]) => v != null)),
              ...(written != null ? { spl: written } : {}),
            },
          },
          undefined,
          { timeout: timeoutMs },
        )
        .then((r) => payloadOf(r, name));

    return {
      ask: async (q: SplunkQuestion, written?: string): Promise<SplunkAnswer> => {
        const got = await call(lookupTool, q, written);
        if (got?.error || typeof got?.spl !== 'string') {
          throw new SplunkLookupError(got?.error ?? `${lookupTool} returned no SPL`, got?.prompt, got?.spl);
        }
        this.logger.log(`ran ${got.count} row(s) for "${q.requirement.slice(0, 60)}": ${got.spl}`);
        return {
          prompt: got.prompt,
          spl: got.spl,
          rows: got.rows ?? [],
          count: got.count ?? 0,
          capped: got.capped === true,
          limit: got.limit ?? 0,
          mock: got.mock === true,
          answer: got.answer ?? '',
          writtenBy: got.written_by,
        };
      },
      writerPrompt: async (q: SplunkQuestion): Promise<string | null> => {
        // An older connector without the tool is not an error: it writes the SPL itself.
        if (!tools.includes(promptTool)) return null;
        const got = await call(promptTool, q);
        return typeof got?.writer_prompt === 'string' ? got.writer_prompt : null;
      },
      generate: async (q: SplunkQuestion): Promise<SplunkDraft> => {
        const got = await call(textToSplTool, q);
        if (got?.error) throw new SplunkLookupError(got.error, got?.prompt);
        return { prompt: got.prompt, generated: got.generated, spl: got.spl, refused: got.refused };
      },
      close: () => client.close(),
    };
  }
}
