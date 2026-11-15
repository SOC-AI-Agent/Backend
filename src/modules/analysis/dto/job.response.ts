import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const JOB_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export const LOOKUP_STATUSES = ['not_requested', 'queued', 'running', 'completed', 'failed'] as const;
export const ANALYSIS_STATUSES = ['running', 'completed', 'failed', 'skipped'] as const;

/** Returned by POST /v1/analyze, at once — the work happens afterwards. */
export class EnqueueResponse {
  /** Poll `GET /v1/results/{job_id}` with it. */
  @ApiProperty({ format: 'uuid' })
  job_id: string;

  @ApiProperty({ example: 'queued' })
  status: string;

  /** A rough figure, not a promise: the first answer is two model calls, and on a machine without a GPU that is minutes. */
  estimated_wait_seconds: number;
}

/**
 * One thing to ask Splunk, as stage 1 planned it: the requirement, and where in
 * Splunk the data catalogue says to ask it. Stored on the job; what "Search
 * Splunk" runs is exactly this.
 */
export class SplunkRequirementResponse {
  /** In plain words, as the requirements agent (or the playbook) wrote it. */
  requirement: string;

  /** Why it is worth asking. */
  @ApiPropertyOptional()
  because?: string;

  /** Lower runs first. The playbook's own searches come before the agent's. */
  @ApiPropertyOptional()
  rank?: number;

  /** The value being pivoted on, taken from the alert. */
  @ApiPropertyOptional({ example: '10.1.100.44' })
  indicator?: string;

  @ApiPropertyOptional({ example: 'ip' })
  indicatorType?: string;

  @ApiPropertyOptional({ example: 'fortigate' })
  index?: string;

  @ApiPropertyOptional()
  sourcetype?: string;

  /**
   * The field names that carry this indicator in this estate (`srcip`, not
   * `src_ip`). Empty means the catalogue has none, and the requirement will be
   * reported "Not searched" rather than run against a guessed name.
   */
  @ApiPropertyOptional({ type: [String] })
  fields?: string[];

  /** How far the search had to widen to find a field. */
  @ApiPropertyOptional({ enum: ['playbook', 'sourcetype', 'index', 'estate', 'none'] })
  scope?: string;

  /**
   * Details from the alert the requirements agent listed under the question, sent
   * to Text-to-SPL with it. Only values that appear in what the agent was shown.
   */
  @ApiPropertyOptional({ example: { source: '45.83.122.9', device: 'FGT-01', user: 'j.smith' } })
  context?: Record<string, string>;

  /** Details the agent wrote that appear nowhere in the alert, as `key: value` — not sent. */
  @ApiPropertyOptional({ type: [String] })
  droppedContext?: string[];

  /** Which field each value sits in here, from the catalogue — sent to Text-to-SPL. */
  @ApiPropertyOptional({ example: [{ value: '45.83.122.9', fields: ['srcip', 'dstip'] }] })
  fieldHints?: Array<{ value: string; fields: string[] }>;

  /** True when the catalogue could not aim it at a field. */
  @ApiPropertyOptional()
  unscoped?: boolean;

  /** How the fields were found: `role` (the catalogue), `cim` (a common name the catalogue lists), `probe` (a search for the value). */
  @ApiPropertyOptional({ enum: ['role', 'cim', 'probe'] })
  aimedBy?: string;

  /** The window, anchored to when the alert fired rather than to when the search runs. */
  @ApiPropertyOptional({ example: '2026-09-20T10:00:00Z' })
  earliest?: string;

  @ApiPropertyOptional({ example: '2026-09-21T11:00:00Z' })
  latest?: string;

  /** Set when this is "how often has this alert fired" rather than an indicator pivot: the alert's name. */
  @ApiPropertyOptional()
  frequencyOf?: string;

  @ApiPropertyOptional()
  days?: number;

  /** Field=value pairs a playbook asked for, in its own field names. */
  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  filters?: Record<string, string>;

  /** Set when the search groups and counts instead of listing: `group_by`, `metrics`, `span`, `sort`. */
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  summarise?: Record<string, unknown>;
}

/** One requirement, and what came back for it. */
export class LookupAnswerResponse {
  requirement: string;

  /**
   * The result as an analyst reads it: which fields were searched, how many events,
   * whether the search stopped at its limit. `Not searched. …` means no search ran —
   * the catalogue had no field for this, which is not the same as nothing happening.
   */
  answer: string;

  /** The agent run behind it. Always null now: no agent runs the search. */
  @ApiProperty({ nullable: true })
  runId: string | null;

  durationMs: number;

  /** Set when the search itself failed (Splunk unreachable, a refused index…). */
  @ApiProperty({ nullable: true })
  error: string | null;

  @ApiPropertyOptional()
  index?: string;

  @ApiPropertyOptional()
  sourcetype?: string;

  @ApiPropertyOptional({ type: [String] })
  fields?: string[];

  /**
   * Who wrote the search. `splunk` now: Splunk's Text-to-SPL, over MCP. `backend`
   * (planned searches) and `agent` (the old query agent) only on older jobs.
   */
  @ApiPropertyOptional({ enum: ['splunk', 'backend', 'agent'] })
  ranBy?: string;

  /** Who wrote the SPL that ran: `agent` (the SPL agent, see splAgent), `assistant` or `template` (the connector). */
  @ApiPropertyOptional()
  writtenBy?: string;

  /** The SPL agent asked for this one, e.g. `soc-spl-writer`, whether or not its draft ran. */
  @ApiPropertyOptional()
  splAgent?: string;

  /** Why the SPL agent's draft was dropped and the connector's search ran instead. */
  @ApiPropertyOptional()
  draftError?: string;

  /** The text sent to Text-to-SPL: the requirement, plus where and when to look. */
  @ApiPropertyOptional()
  prompt?: string;

  /** The SPL that ran, exactly as sent. An answer is a claim; this is what makes it checkable. Absent when nothing was searched. */
  @ApiPropertyOptional()
  spl?: string;

  /** Rows or events returned. */
  @ApiPropertyOptional()
  count?: number;
}

/**
 * The second reading, written after the Splunk searches by an agent with no tools.
 * It cites results as `[splunk N]`, N being the 1-based position in `lookup_result`.
 */
export class FinalAnalysisResponse {
  /** `running` while it is being written; `skipped` when no search ran, so there was nothing new to read. */
  @ApiProperty({ enum: ANALYSIS_STATUSES })
  status: string;

  @ApiPropertyOptional()
  text?: string;

  /** Why `failed`. The searches are unaffected. */
  @ApiPropertyOptional()
  error?: string;

  /** Why `skipped`. */
  @ApiPropertyOptional()
  reason?: string;

  @ApiPropertyOptional({ example: 'qwen2.5:7b' })
  model?: string;

  @ApiPropertyOptional()
  runId?: string | null;

  @ApiPropertyOptional()
  durationMs?: number;

  @ApiPropertyOptional()
  startedAt?: string;

  @ApiPropertyOptional()
  completedAt?: string;

  /** How many results it was given, so `[splunk N]` can be checked against the list. */
  @ApiPropertyOptional()
  resultsUsed?: number;
}

/** A job as the list and the detail both show it. */
export class JobResponse {
  @ApiProperty({ format: 'uuid' })
  job_id: string;

  alert_id: string;
  alert_name: string;
  raw_log: string;

  /** Stage 1. `completed` means the suggestion is ready, not that Splunk was searched. */
  @ApiProperty({ enum: JOB_STATUSES })
  status: string;

  /** The suggestion, written by `soc-suggest`. Null until stage 1 completes. */
  @ApiProperty({ nullable: true })
  ai_response: string | null;

  @ApiProperty({ nullable: true })
  error_message: string | null;

  @ApiProperty({ nullable: true, example: 'qwen2.5:7b' })
  model_used: string | null;

  /** What an analyst waited for: enrichment plus both stage-1 model calls. */
  @ApiProperty({ nullable: true })
  processing_time_ms: number | null;

  @ApiProperty({ nullable: true })
  tokens_prompt: number | null;

  @ApiProperty({ nullable: true })
  tokens_eval: number | null;

  created_at: Date;

  @ApiProperty({ nullable: true })
  completed_at: Date | null;

  /** The suggestion agent's run on the LLM server, for reading its trace. */
  @ApiProperty({ nullable: true })
  agent_run_id: string | null;

  /** What stage 1 planned to ask Splunk. Empty when it wanted nothing. */
  @ApiProperty({ type: [SplunkRequirementResponse] })
  splunk_requirements: SplunkRequirementResponse[];

  /**
   * Stage 2. Separate from `status` on purpose: a job is `completed` once the
   * suggestion is in, and the Splunk stage may never be asked for. Stays `running`
   * until the analysis after the searches is written too.
   */
  @ApiProperty({ enum: LOOKUP_STATUSES })
  lookup_status: string;

  @ApiProperty({ nullable: true })
  lookup_error: string | null;

  /** Searches and the analysis together. */
  @ApiProperty({ nullable: true })
  lookup_time_ms: number | null;

  @ApiProperty({ nullable: true })
  lookup_completed_at: Date | null;
}

/** The detail view: everything above, and the evidence and the Splunk results. */
export class JobDetailResponse extends JobResponse {
  /**
   * What was established before any model ran: extracted indicators, ThreatQ, the
   * matched playbook, the source and the suggested lookups. Kept apart from
   * `ai_response` because it is checkable.
   */
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  evidence: Record<string, unknown> | null;

  /** One per requirement, in the order they ran, numbered from 1 by the dashboard. */
  @ApiProperty({ type: [LookupAnswerResponse] })
  lookup_result: LookupAnswerResponse[];

  /** Null until the Splunk stage has produced one (or when it was switched off). */
  @ApiProperty({ type: FinalAnalysisResponse, nullable: true })
  final_analysis: FinalAnalysisResponse | null;
}

export class JobListResponse {
  /** Matching jobs, before `skip` and `limit`. */
  total: number;

  @ApiProperty({ type: [JobResponse] })
  items: JobResponse[];
}

/** Returned by POST /v1/jobs/{job_id}/lookup. */
export class LookupRequestedResponse {
  @ApiProperty({ format: 'uuid' })
  job_id: string;

  @ApiProperty({ example: 'queued' })
  lookup_status: string;

  /** What will be run: exactly what stage 1 stored, not re-derived. */
  @ApiProperty({ type: [SplunkRequirementResponse] })
  requirements: SplunkRequirementResponse[];
}
