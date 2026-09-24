/**
 * Stage 2 — searching Splunk for what stage 1 said it wanted.
 *
 * Its own queue, not another job name on the analysis queue. One lookup is a
 * full agent run per requirement, minutes each without a GPU; sharing a queue
 * would put that in front of every alert still waiting to be triaged, and the
 * fast first answer is the whole point of splitting the two.
 */
export const LOOKUP_QUEUE = 'splunk-lookup';
export const RUN_LOOKUP_JOB = 'run_lookup';

export interface SplunkLookupPayload {
  jobId: string;
  /** Who asked: a username when someone pressed the button, 'auto' otherwise. */
  requestedBy: string;
}

/** One requirement, and what came back for it. Stored on the job row. */
export interface LookupAnswer {
  requirement: string;
  answer: string;
  /** The run on the LLM server, so the search it built can be read afterwards. */
  runId: string | null;
  durationMs: number;
  error: string | null;
  /**
   * Where this one was aimed, copied from the plan. Recorded beside the answer
   * so "0 events" can be read: against a named field it means the events are
   * not there, and with no field named it may only mean the search looked in
   * the wrong place.
   */
  index?: string;
  sourcetype?: string;
  fields?: string[];
  /**
   * Who ran it. Always 'backend' now: a planned search is sent straight to the
   * connector and a requirement with no plan is not searched. 'agent' is what
   * jobs stored before the query agent was removed still carry, so it stays in
   * the type and the dashboard still reads it.
   */
  ranBy?: 'backend' | 'agent';
  /**
   * The search that actually ran, exactly as Splunk received it.
   *
   * The one artifact worth keeping. An answer of "2 events" is a claim; the
   * query beside it is what makes the claim checkable — whether it looked at
   * the right fields, the right index, the right window. Before the searches
   * were planned this was visible in the agent's trace; planning them made the
   * searches better and, until now, invisible.
   */
  spl?: string;
  count?: number;
}

/**
 * The reading written after the searches, from the suggestion and the numbered
 * results together. Stored beside the answers it cites, in the same column, so
 * the two cannot be separated and no migration is needed.
 */
export interface FinalAnalysis {
  /** running until it finishes; skipped when there was nothing to analyse. */
  status: 'running' | 'completed' | 'failed' | 'skipped';
  text?: string;
  error?: string | null;
  /** Why it was skipped. */
  reason?: string;
  model?: string;
  runId?: string | null;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
  /** How many results it was given, so "[splunk 3]" can be checked against a list. */
  resultsUsed?: number;
}

/** What lookup_result holds. */
export interface StoredLookup {
  answers: LookupAnswer[];
  analysis?: FinalAnalysis;
}

/**
 * Read lookup_result whichever shape it has. Jobs searched before the analysis
 * existed stored a bare array of answers; newer ones store `{ answers, analysis }`.
 */
export function splitLookup(raw: unknown): StoredLookup {
  if (Array.isArray(raw)) return { answers: raw as LookupAnswer[] };
  if (raw && typeof raw === 'object' && Array.isArray((raw as StoredLookup).answers)) {
    return raw as StoredLookup;
  }
  return { answers: [] };
}
