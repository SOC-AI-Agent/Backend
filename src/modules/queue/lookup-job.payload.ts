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
   * Who actually ran it: 'backend' for a planned search sent straight to the
   * connector, 'agent' when the query agent had to work it out. Worth recording
   * — the two differ by three orders of magnitude in cost, and a run that
   * quietly fell back to the agent is the one to look at.
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
