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
     * The Confluence connector. Asked once per alert, before the model runs:
     * which runbook covers this, and what does it say makes it real.
     * Unset means the step is skipped — a weaker suggestion, not a failure.
     */
    url: process.env.CONFLUENCE_MCP_URL ?? '',
    token: process.env.CONFLUENCE_MCP_AUTH_TOKEN ?? '',
    timeoutMs: toInt(process.env.PLAYBOOK_TIMEOUT, 15) * 1000,
  },
  splunk: {
    /**
     * The Splunk connector's HTTP base. The backend builds every search itself
     * (modules/enrichment/spl.ts) and sends the SPL to the connector's /query
     * route, which runs it.
     */
    url: process.env.SPLUNK_MCP_URL ?? 'http://soc-mcp-splunk:8200',
    token: process.env.MCP_AUTH_TOKEN ?? '',
    /**
     * Which indexes a search may name, or "*" to opt out on purpose. Built into
     * every query here, and checked again by the connector — set both the same.
     * Empty refuses every search rather than searching everything.
     */
    allowedIndexes: (process.env.SPLUNK_ALLOWED_INDEXES ?? '')
      .split(',')
      .map((i) => i.trim())
      .filter(Boolean),
    /** Ceiling on rows, whatever a plan asks for. */
    maxCount: toInt(process.env.SPLUNK_MAX_COUNT, 200),
    /** Where correlation-search alerts land, and the field holding their name. Splunk ES defaults. */
    alertIndex: process.env.SPLUNK_ALERT_INDEX ?? 'notable',
    alertNameField: process.env.SPLUNK_ALERT_NAME_FIELD ?? 'search_name',
    // A planned search is one Splunk call. The 0.4s measured here is typical;
    // this is a ceiling on a slow search head, not a budget for inference.
    timeoutMs: toInt(process.env.SPLUNK_SEARCH_TIMEOUT, 120) * 1000,
  },
  lookup: {
    /**
     * 'manual' | 'auto' — when the Splunk stage runs.
     *
     * manual keeps the requirements on the job row and waits for someone to
     * press the button. Each requirement is a search against a production Splunk;
     * making it deliberate means that load is spent on alerts a person actually
     * wants it spent on.
     */
    mode: (process.env.SPLUNK_LOOKUP_MODE ?? 'manual').toLowerCase() === 'auto'
      ? 'auto'
      : 'manual',
    /**
     * Whether the results are read by an agent once they are in. Off leaves the
     * answers as they are, for a deployment that does not want another model call.
     */
    analyse: toBool(process.env.SPLUNK_LOOKUP_ANALYSE, true),
    /** A cap on how many of stage 1's requirements are actually run. */
    maxRequirements: toInt(process.env.SPLUNK_LOOKUP_MAX_REQUIREMENTS, 5),
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

    // Indicators that belong to us. An internal address or domain is not worth
    // a threat-intelligence call, and a "no record" reply for one is exactly
    // what gets misread as "clean".
    internal: (process.env.ENRICHMENT_INTERNAL_VALUES ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
    threatq: {
      // The ThreatQ gateway's HTTP lookup route. Blank disables enrichment,
      // and the summary then says the check did not happen.
      url: process.env.THREATQ_LOOKUP_URL ?? '',
      token: process.env.THREATQ_MCP_AUTH_TOKEN ?? '',
      timeoutMs: Number.parseInt(process.env.THREATQ_LOOKUP_TIMEOUT_MS ?? '15000', 10),
      // One alert can carry dozens of addresses; looking up all of them costs
      // the platform more than the answer is worth.
      maxIndicators: Number.parseInt(process.env.THREATQ_MAX_INDICATORS ?? '25', 10),
    },
  },
});
