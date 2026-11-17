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

/** Where the playbooks are synced from, as this backend is configured. */
export class PlaybookSourceResponse {
  /** CONFLUENCE_BASE_URL, CONFLUENCE_SPACE_KEY and CONFLUENCE_API_TOKEN are all set. */
  configured: boolean;
  /** The variables still empty in Backend/.env; a sync cannot run until they are set. */
  missing: string[];

  @ApiPropertyOptional({ nullable: true })
  base_url?: string | null;

  @ApiPropertyOptional({ nullable: true })
  space_key?: string | null;

  /** Minutes between the worker's syncs. */
  sync_minutes: number;
}

export class PlaybookStatusResponse {
  /** The backend's side: whether it can read Confluence at all. */
  confluence: PlaybookSourceResponse;

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

/** What one sync did: pages read from Confluence, and what soc-ai indexed and embedded. */
export class PlaybookSyncResultResponse {
  ok: boolean;

  @ApiPropertyOptional({ nullable: true })
  at?: string | null;

  @ApiPropertyOptional()
  pages?: number;

  @ApiPropertyOptional()
  playbooks?: number;

  /** Fields embedded into Qdrant by this sync. Unchanged text is reused, not re-embedded. */
  @ApiPropertyOptional()
  embedded?: number;

  @ApiPropertyOptional()
  reused?: number;
}

export class PlaybookSyncResponse {
  sync: PlaybookSyncResultResponse;
  /** The index after the sync, as GET /admin/playbooks shows it. */
  index: PlaybookStatusResponse;
}
