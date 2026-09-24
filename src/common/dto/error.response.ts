/**
 * What every error looks like.
 *
 * The exception filter renders each failure — validation, auth, not found, a crash —
 * as `{ "detail": "..." }`, because the dashboard reads `err.response.data.detail`
 * everywhere. Validation messages are joined with `; `.
 */
export class ErrorResponse {
  /** What went wrong, in words: `X-API-Key header required`, `Job not found`, `alert_id should not be empty`. */
  detail: string;
}
