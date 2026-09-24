import { ApiProperty } from '@nestjs/swagger';

/** An API key as listed. The key itself is never shown again. */
export class ApiKeyResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  name: string;

  /** The first characters of the key — enough to recognise it, not to use it. */
  key_prefix: string;

  owner_username: string;
  is_active: boolean;

  /** Null for a key that never expires. */
  @ApiProperty({ nullable: true })
  expires_at: Date | null;

  @ApiProperty({ nullable: true })
  last_used_at: Date | null;

  created_at: Date;
}

/** Returned once, at creation. */
export class CreatedApiKeyResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  name: string;

  /** The full key. Shown here and never again — only its SHA-256 is stored. Send it as `X-API-Key`. */
  key: string;

  key_prefix: string;

  @ApiProperty({ nullable: true })
  expires_at: Date | null;

  created_at: Date;
}
