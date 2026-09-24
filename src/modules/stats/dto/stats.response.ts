export class StatsResponse {
  total_jobs: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;

  /** Mean of `processing_time_ms` over completed jobs. */
  avg_processing_ms: number;

  /** Prompt plus generated tokens, over completed jobs. */
  total_tokens: number;
  avg_tokens: number;

  /** The model name the backend reports (OLLAMA_MODEL). */
  model: string;
}
