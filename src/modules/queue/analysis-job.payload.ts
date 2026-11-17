export const ANALYSIS_QUEUE = 'analysis';
export const ANALYZE_ALERT_JOB = 'analyze_alert';

export interface AnalyzeAlertPayload {
  jobId: string;
  alertId: string;
  alertName: string;
  /** The SOC's use case code, when the SOAR sent one. Only in the queue
   *  payload, not on the job row: it is used once, to pick the playbook.
   *  shortcut: not shown on the dashboard; add an ai_jobs column if analysts need it. */
  useCaseId?: string;
  rawLog: string;
  /** Indicators the SOAR already parsed. Its playbook had the structured
   *  record; a regex here only has the rendering of it, so these win. */
  indicators?: Array<{ type: string; value: string; source: string }>;
  apiKeyId?: string | null;
  actorLabel?: string | null;
  ipAddress?: string | null;
}
