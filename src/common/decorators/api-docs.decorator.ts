import { applyDecorators } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiSecurity,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ErrorResponse } from '../dto/error.response';

/**
 * What the guards already enforce, said to Swagger.
 *
 * Without these the Authorize button exists but no operation asks for it, so
 * "Try it out" sends no token and every protected call comes back 401.
 */

/** Routes behind ApiKeyGuard — SOAR and other callers with an `X-API-Key`. */
export const ApiApiKeyAuth = () =>
  applyDecorators(
    ApiSecurity('X-API-Key'),
    ApiUnauthorizedResponse({
      type: ErrorResponse,
      description: 'No `X-API-Key` header, or the key is wrong, revoked or expired.',
    }),
  );

/** Routes behind JwtAuthGuard — a signed-in dashboard user. */
export const ApiJwtAuth = () =>
  applyDecorators(
    ApiBearerAuth(),
    ApiUnauthorizedResponse({
      type: ErrorResponse,
      description: 'No bearer token, or it is invalid or expired.',
    }),
  );

/** Routes behind JwtAuthGuard and RolesGuard — the role has to be one that is named. */
export const ApiRoleAuth = (...roles: string[]) =>
  applyDecorators(
    ApiJwtAuth(),
    ApiForbiddenResponse({
      type: ErrorResponse,
      description: `The signed-in user's role is not allowed. Allowed: ${roles.join(', ')}.`,
    }),
  );
