import { ApiProperty } from '@nestjs/swagger';

export const EVENT_TYPES = [
  'ANALYZE_REQUEST', 'JOB_QUEUED', 'JOB_PROCESSING', 'JOB_COMPLETED', 'JOB_FAILED',
  'AUTH_LOGIN', 'AUTH_FAILED', 'AUTH_REFRESH', 'AUTH_KEY_FAILED', 'KEY_CREATED',
  'KEY_REVOKED', 'USER_CREATED', 'USER_UPDATED', 'USER_DELETED', 'AUDIT_EXPORTED',
  'SYSTEM_CLEANUP',
] as const;

export class AuditLogResponse {
  id: number;

  @ApiProperty({ enum: EVENT_TYPES })
  event_type: string;

  @ApiProperty({ enum: ['user', 'api_key', 'system'] })
  actor_type: string;

  @ApiProperty({ nullable: true })
  actor_label: string | null;

  @ApiProperty({ nullable: true })
  endpoint: string | null;

  @ApiProperty({ nullable: true })
  http_method: string | null;

  @ApiProperty({ nullable: true })
  ip_address: string | null;

  @ApiProperty({ nullable: true, format: 'uuid' })
  job_id: string | null;

  /** The prompt as it was sent, when the event is a job completing. */
  @ApiProperty({ nullable: true })
  prompt_snapshot: string | null;

  @ApiProperty({ nullable: true })
  ai_response_snapshot: string | null;

  @ApiProperty({ nullable: true })
  status_code: number | null;

  @ApiProperty({ nullable: true })
  duration_ms: number | null;

  /** Event-specific detail: the alert id, the model, what a rejected key looked like. */
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  extra_data: Record<string, unknown> | null;

  timestamp: Date;
}

export class AuditLogListResponse {
  /** Matching entries, before `skip` and `limit`. */
  total: number;

  @ApiProperty({ type: [AuditLogResponse] })
  items: AuditLogResponse[];
}
