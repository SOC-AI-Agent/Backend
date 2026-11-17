/**
 * Central config. Env names are kept identical to the previous FastAPI backend
 * so a single root .env still drives the whole stack.
 */
export interface AppConfig {
  appName: string;
  appEnv: string;
  debug: boolean;
  port: number;
  /** 'api' serves HTTP, 'worker' only consumes the BullMQ queue + cron. */
  role: 'api' | 'worker';
  allowedOrigins: string[];
}

const toBool = (v: string | undefined, fallback = false): boolean =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const toInt = (v: string | undefined, fallback: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isNaN(n) ? fallback : n;
};

/**
 * CONFLUENCE_BASE_URL as the site, the space it names, and — for a Cloud page
 * or folder — what to read: pasted from the browser's address bar:
 *   https://acme.atlassian.net/wiki/spaces/SOC/overview         -> .../wiki, SOC, the whole space
 *   https://acme.atlassian.net/wiki/spaces/SOC/pages/123/Title  -> .../wiki, SOC, page 123 and all under it
 *   https://acme.atlassian.net/wiki/spaces/SOC/folder/456       -> .../wiki, SOC, all in folder 456
 *   https://confluence.corp/display/SOC/Some+Page                -> site root, SOC, the whole space
 *   https://confluence.corp/spaces/viewspace.action?key=SOC      -> site root, SOC, the whole space
 *   https://acme.atlassian.net/wiki                              -> as it is, CONFLUENCE_SPACE_KEY
 * The space named in the URL wins over CONFLUENCE_SPACE_KEY, which is for a
 * plain site URL. A page or folder narrows the read to that part of the tree
 * (Cloud, API v2); everything else reads the whole space.
 */
export interface ConfluenceSite {
  baseUrl: string;
  spaceKey: string;
  /** The page or folder to read from, '' for the whole space. */
  rootType: '' | 'page' | 'folder';
  rootId: string;
}

export function confluenceSite(raw: string | undefined, spaceKey: string | undefined): ConfluenceSite {
  const given = (spaceKey ?? '').trim();
  const text = (raw ?? '').trim();
  const whole = { rootType: '' as const, rootId: '' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { baseUrl: text.replace(/\/+$/, ''), spaceKey: given, ...whole };
  }
  const path = url.pathname.replace(/\/+$/, '');
  const m = path.match(/^(.*?)\/(?:spaces|display)\/([^/]+)(.*)$/);
  if (m && m[2] !== 'viewspace.action') {
    const site = { baseUrl: url.origin + m[1], spaceKey: decodeURIComponent(m[2]) };
    // Cloud's /spaces/KEY/pages/ID/Title (or pages/edit-v2/ID) and /spaces/KEY/folder/ID.
    const page = m[3].match(/^\/pages\/(?:edit-v2\/)?(\d+)/);
    if (page) return { ...site, rootType: 'page', rootId: page[1] };
    const folder = m[3].match(/^\/folder\/(\d+)/);
    if (folder) return { ...site, rootType: 'folder', rootId: folder[1] };
    return { ...site, ...whole };
  }
  // Server/DC's .action pages: the site is what comes before them, the space
  // their key= if they carry one (viewpage.action?pageId= does not).
  const action = path.match(/^(.*?)\/(?:spaces|pages)\/[^/]+\.action$/);
  if (action) {
    const key = url.searchParams.get('key') ?? url.searchParams.get('spaceKey');
    return { baseUrl: url.origin + action[1], spaceKey: key ?? given, ...whole };
  }
  return { baseUrl: url.origin + path, spaceKey: given, ...whole };
}

export default () => ({
  app: {
    appName: process.env.APP_NAME ?? 'SOC AI Suggestion',
    appEnv: process.env.APP_ENV ?? 'development',
    debug: toBool(process.env.DEBUG),
    port: toInt(process.env.PORT, 8000),
    role: (process.env.APP_ROLE ?? 'api') as 'api' | 'worker',
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3001')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  },
  diagnostics: {
    schemaDebug: toBool(process.env.DB_SCHEMA_DEBUG),
  },
  jwt: {
    secret: process.env.JWT_SECRET_KEY ?? 'change-me-in-production-use-long-random-string',
    algorithm: process.env.JWT_ALGORITHM ?? 'HS256',
    accessExpireMinutes: toInt(process.env.JWT_ACCESS_EXPIRE_MINUTES, 15),
    refreshExpireDays: toInt(process.env.JWT_REFRESH_EXPIRE_DAYS, 7),
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'soc-redis',
    port: toInt(process.env.REDIS_PORT, 6379),
    db: toInt(process.env.REDIS_DB, 0),
  },
  ai: {
    /** Base URL of the Python AI service (../ai-service). */
    baseUrl: process.env.AI_SERVICE_URL ?? 'http://soc-ai:8100',
    /** Reported back to callers / stored on the job row. */
    model: process.env.OLLAMA_MODEL,
    /**
     * The agent behind the first answer: one call, no tools, writing the
     * suggestion. What to ask Splunk is a second call to a second agent, and
     * what the results mean is a third. Naming each here rather than leaving it
     * to the AI service's default keeps them from silently becoming the same
     * agent again.
     */
    suggestAgent: process.env.LLM_SUGGEST_AGENT ?? 'soc-suggest',
    /** Stage 1b: reads the alert and the suggestion, writes what to ask Splunk. */
    requirementsAgent: process.env.LLM_REQUIREMENTS_AGENT ?? 'soc-requirements',
    /** Stage 3: reads the suggestion and the Splunk results, writes the second reading. */
    concludeAgent: process.env.LLM_CONCLUDE_AGENT ?? 'soc-conclude',
    /**
     * Stage 2: writes the SPL for a requirement from the connector's writer
     * prompt. Always on — `soc-spl-writer` is built into Agent-Server (DALL-M),
     * which creates it itself, so the slug is fixed rather than configured. A
     * failed or refused draft falls back to the connector's own SPL.
     */
    splAgent: (process.env.LLM_SPL_AGENT ?? '').trim() || 'soc-spl-writer',
    /**
     * A suggestion or analysis that breaks the playbook rules (a verdict with no
     * [PB:true]/[PB:false] behind it, a step the playbook does not have, a quote
     * it does not contain) is sent back to the agent once with what was wrong.
     * Off: the reply is kept as it came and only flagged on the job.
     */
    groundingRetry: (process.env.LLM_GROUNDING_RETRY ?? 'true').toLowerCase() !== 'false',
    /**
     * Bearer token soc-ai requires on every route but /health. Must match
     * AI_SERVICE_AUTH_TOKEN in AI-Service/.env byte for byte.
     */
    token: process.env.AI_SERVICE_AUTH_TOKEN ?? '',
    /**
     * How long to wait on soc-ai for ONE agent call — soc-ai calls the LLM
     * server, which runs the agent — so it has to be longer than the LLM
     * server's own LLM_TIMEOUT, not shorter. At 120s every job died on
     * a timeout while the agents were still working.
     *
     * OLLAMA_TIMEOUT is still read for older .env files, but the backend has
     * not spoken to Ollama since the LLM server took over inference.
     */
    timeoutMs:
      toInt(process.env.AI_SERVICE_TIMEOUT ?? process.env.OLLAMA_TIMEOUT, 1920) *
      1000,
  },
  playbook: {
    /**
     * Where the playbook pages come from: Confluence itself. The worker reads
     * every current page of the space every syncMinutes and sends them to soc-ai,
     * which extracts, embeds and matches them. Unset means nothing is synced, and
     * every match says nothing is indexed — a weaker suggestion, not a failure.
     */
    confluence: {
      /** https://your-org.atlassian.net/wiki (Cloud) or https://confluence.corp (Server/DC). */
      ...confluenceSite(process.env.CONFLUENCE_BASE_URL, process.env.CONFLUENCE_SPACE_KEY),
      /** Cloud is <base>/wiki/rest/api, so with /wiki in the base this stays /rest/api. */
      apiPath: process.env.CONFLUENCE_API_PATH ?? '/rest/api',
      /** Cloud: email + API token as basic auth. Blank email: the token is a Server/DC PAT, sent as a bearer. */
      email: process.env.CONFLUENCE_EMAIL ?? '',
      apiToken: process.env.CONFLUENCE_API_TOKEN ?? '',
      pageLimit: toInt(process.env.CONFLUENCE_PAGE_LIMIT, 200),
      /**
       * Which REST API: v2 (/api/v2/spaces/{id}/pages) for Cloud, where
       * Atlassian is retiring v1; v1 (<apiPath>/content) for Server/DC, which
       * has only v1. auto picks v2 for *.atlassian.net and v1 otherwise.
       */
      api: (process.env.CONFLUENCE_API ?? 'auto').trim().toLowerCase(),
      /**
       * An HTTP proxy for the Confluence calls alone, e.g. the office proxy for
       * Cloud from a host with no direct way out. HTTPS goes through it as a
       * CONNECT tunnel, so the proxy sees the host name, never the token or the
       * pages. Blank: direct. Nothing else the backend calls uses it.
       */
      proxy: (process.env.CONFLUENCE_PROXY ?? '').trim(),
    },
    /** One match, asked of soc-ai once per alert before the model runs. */
    timeoutMs: toInt(process.env.PLAYBOOK_TIMEOUT, 15) * 1000,
    syncMinutes: toInt(process.env.PLAYBOOK_SYNC_MINUTES, 60),
    /**
     * Reading the whole space, then indexing it. Only fields whose text changed
     * are embedded, but the first sync after a fresh volume embeds everything.
     */
    syncTimeoutMs: toInt(process.env.PLAYBOOK_SYNC_TIMEOUT, 300) * 1000,
  },
  splunk: {
    /**
     * The Splunk connector's MCP endpoint (MCP-Server/Splunk, soc-mcp-splunk). The
     * Splunk stage sends each requirement to it as stage 1 stored it and gets the SPL
     * that ran and its rows back (enrichment/splunk-mcp.service.ts). Which Splunk is
     * behind it — mock events, a Splunk container, the company's — and how the SPL
     * is written is configured there, in MCP-Server/.env. A bare base URL gets
     * /services/mcp added.
     */
    mcpUrl: process.env.SPLUNK_MCP_URL ?? 'http://soc-mcp-splunk:8200/services/mcp',
    /**
     * Bearer token for that endpoint: the connector's MCP_AUTH_TOKEN, byte for
     * byte. SPLUNK_MCP_TOKEN overrides it. Splunk's own token is the connector's
     * to hold, not the backend's.
     */
    token: process.env.SPLUNK_MCP_TOKEN || process.env.MCP_AUTH_TOKEN || '',
    /** The connector's tools: a whole lookup, and Text-to-SPL alone. */
    lookupTool: process.env.SPLUNK_MCP_LOOKUP_TOOL ?? 'splunk_lookup',
    textToSplTool: process.env.SPLUNK_MCP_TEXT_TO_SPL_TOOL ?? 'splunk_text_to_spl',
    /** What to show an agent that writes the SPL. Only called when LLM_SPL_AGENT is set. */
    promptTool: process.env.SPLUNK_MCP_PROMPT_TOOL ?? 'splunk_prompt',
    /** Runs one checked, read-only search. Used to find which field a value is in. */
    runTool: process.env.SPLUNK_MCP_RUN_TOOL ?? 'splunk_run_query',
    // One MCP tool call, which is Text-to-SPL and the search together. Splunk AI
    // Assistant takes tens of seconds; Splunk's own guardrail stops a search at
    // one minute.
    timeoutMs: toInt(process.env.SPLUNK_SEARCH_TIMEOUT, 120) * 1000,
  },
  lookup: {
    /**
     * 'manual' | 'auto' | 'off' — when the Splunk stage runs.
     *
     * manual keeps the requirements on the job row and waits for someone to
     * press the button. Each requirement is a search against a production Splunk;
     * making it deliberate means that load is spent on alerts a person actually
     * wants it spent on.
     *
     * off is stage 1 alone: the suggestion agent is the only model call, and
     * neither the requirements agent nor the where-to-search block in its
     * prompt is spent on a search nobody will run.
     */
    mode: ((m) => (m === 'auto' || m === 'off' ? m : 'manual'))(
      (process.env.SPLUNK_LOOKUP_MODE ?? 'manual').toLowerCase(),
    ),
    /**
     * Whether the results are read by an agent once they are in. Off leaves the
     * answers as they are, for a deployment that does not want another model call.
     */
    analyse: toBool(process.env.SPLUNK_LOOKUP_ANALYSE, true),
    /** A cap on how many of stage 1's requirements are actually run. */
    maxRequirements: toInt(process.env.SPLUNK_LOOKUP_MAX_REQUIREMENTS, 5),
    /** Whether to add the "how often this alert fired" frequency lookup (requires Splunk ES `notable` or a dedicated alert index). */
    alertFrequency: toBool(process.env.SPLUNK_ALERT_FREQUENCY, true),
    /**
     * When the catalogue has no field for a value, run one small search for it in
     * the alert's index and sourcetype and aim at the field it turns up in
     * (enrichment/field-probe.service.ts). Off sends such values as quoted terms.
     */
    fieldProbe: toBool(process.env.SPLUNK_FIELD_PROBE, true),
    /** At most this many probe searches per job; answers are cached per sourcetype and type. */
    maxProbes: toInt(process.env.SPLUNK_FIELD_PROBE_MAX, 3),
    /** How long a found field is trusted, in hours. */
    probeCacheMs: toInt(process.env.SPLUNK_FIELD_PROBE_CACHE_HOURS, 6) * 3_600_000,
  },
  retention: {
    jobsDays: toInt(process.env.RETENTION_DAYS_JOBS, 30),
    auditDays: toInt(process.env.RETENTION_DAYS_AUDIT, 90),
    cleanupHour: toInt(process.env.CLEANUP_HOUR, 2),
    cleanupMinute: toInt(process.env.CLEANUP_MINUTE, 0),
  },

  enrichment: {
    // Which index holds the logs for the device that raised an alert. The SOAR
    // already names the device, so the first place to search is a lookup rather
    // than something the model has to work out.
    //   ALERT_SOURCE_MAP=fortigate=network:fortigate_traffic,crowdstrike=endpoint
    sourceMap: process.env.ALERT_SOURCE_MAP ?? '',
    // Log families identified by which fields they carry, for alerts forwarded
    // raw rather than as ES notables:
    //   ALERT_SOURCE_SIGNATURES=eventSource+awsRegion=cloud:aws:cloudtrail
    sourceSignatures: process.env.ALERT_SOURCE_SIGNATURES ?? '',

    // ES notable fields about the search, not the event: its time window and
    // its own ids. Removed before indicators are extracted and before the
    // prompt is built — over a third of a notable's tokens, and source_event_id
    // ends in 32 hex characters that were extracted as an MD5 and looked up in
    // ThreatQ. The job row keeps the raw log as sent. Set empty to keep all.
    dropFields: (
      process.env.ALERT_DROP_FIELDS ??
      'info_min_time,info_max_time,info_search_time,source_event_id,source_guid,orig_time,orig_investigation_type'
    )
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),

    // Indicators that belong to us. An internal address or domain is not worth
    // a threat-intelligence call, and a "no record" reply for one is exactly
    // what gets misread as "clean".
    internal: (process.env.ENRICHMENT_INTERNAL_VALUES ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
    threatq: {
      // ThreatQ itself. Blank disables enrichment, and the summary then says
      // the check did not happen.
      baseUrl: (process.env.THREATQ_BASE_URL ?? '').replace(/\/+$/, ''),
      // oauth: password grant at tokenPath, refreshed before it expires.
      // bearer: a static API token, sent as it is.
      authMode: (process.env.THREATQ_AUTH_MODE ?? 'oauth').toLowerCase() === 'bearer' ? 'bearer' : 'oauth',
      tokenPath: process.env.THREATQ_TOKEN_PATH ?? '/api/token',
      clientId: process.env.THREATQ_CLIENT_ID ?? '',
      email: process.env.THREATQ_EMAIL ?? '',
      password: process.env.THREATQ_PASSWORD ?? '',
      token: process.env.THREATQ_TOKEN ?? '',
      // Looking an indicator up by value is a search: GET /api/indicators has no
      // value filter (REST API Reference v5.12).
      searchPath: process.env.THREATQ_SEARCH_PATH ?? '/api/indicators/search',
      // Score, sources and adversaries are related objects and are ABSENT unless
      // named here. Without this every indicator comes back looking unscored.
      searchWith: process.env.THREATQ_SEARCH_WITH ?? 'score,sources,adversaries,status,type,attributes',
      // One request to ThreatQ.
      timeoutMs: Number.parseInt(process.env.THREATQ_LOOKUP_TIMEOUT_MS ?? '15000', 10),
      // One alert can carry dozens of addresses; looking up all of them costs
      // the platform more than the answer is worth.
      maxIndicators: Number.parseInt(process.env.THREATQ_MAX_INDICATORS ?? '25', 10),
    },
  },
});
