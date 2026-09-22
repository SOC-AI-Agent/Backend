export const ANALYSIS_QUEUE = 'analysis';
export const ANALYZE_ALERT_JOB = 'analyze_alert';

export interface AnalyzeAlertPayload {
  jobId: string;
  alertId: string;
  alertName: string;
  rawLog: string;
  /** Indicators the SOAR already parsed. Its playbook had the structured
   *  record; a regex here only has the rendering of it, so these win. */
  indicators?: Array<{ type: string; value: string; source: string }>;
  apiKeyId?: string | null;
  actorLabel?: string | null;
  ipAddress?: string | null;
}
