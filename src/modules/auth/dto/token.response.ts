import { ApiProperty } from '@nestjs/swagger';

/** A signed-in session: send `access_token` as `Authorization: Bearer …`. */
export class TokenResponse {
  /** Short-lived (JWT_ACCESS_EXPIRE_MINUTES). */
  access_token: string;

  /** Longer-lived (JWT_REFRESH_EXPIRE_DAYS). Exchange it at POST /auth/refresh for a new pair. */
  refresh_token: string;

  @ApiProperty({ example: 'bearer' })
  token_type: string;
}

export class MeResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  username: string;
  email: string;

  @ApiProperty({ enum: ['admin', 'analyst', 'readonly'] })
  role: string;

  is_active: boolean;
}
