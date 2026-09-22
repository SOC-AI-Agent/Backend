import { ApiKey, Role, User } from '@prisma/client';

export type AuthUser = User & { role: Role };
export type ApiKeyRecord = ApiKey;

export interface JwtPayload {
  sub: string;
  username: string;
  type: 'access' | 'refresh';
  exp?: number;
  iat?: number;
}
