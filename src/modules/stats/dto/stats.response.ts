import { ApiPropertyOptional } from '@nestjs/swagger';

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

export class PlaybookStatusResponse {
  indexed: boolean;
  playbooks: number;

  @ApiPropertyOptional({ nullable: true })
  source?: string | null;

  @ApiPropertyOptional({ nullable: true })
  built_at?: string | null;

  pages: number;

  @ApiPropertyOptional({ type: 'array', items: { type: 'object' } })
  skipped?: Array<Record<string, unknown>>;

  @ApiPropertyOptional({ type: 'array', items: { type: 'object' } })
  conflicts?: Array<Record<string, unknown>>;

  names: number;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  semantic?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  vectordb?: Record<string, unknown>;
}
