import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { ApiKeyRecord } from '../types/auth-user';

/** Resolves the API key record attached by ApiKeyGuard. */
export const CurrentApiKey = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().apiKey as ApiKeyRecord;
});
