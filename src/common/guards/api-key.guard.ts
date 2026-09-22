import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../modules/audit/audit.service';
import { hashApiKey, keyPrefixOf } from '../crypto';
import { clientIp } from '../request-context';

/**
 * X-API-Key auth for SOAR/external callers. Equivalent to FastAPI's
 * get_api_key_record: look up by 11-char prefix, compare SHA-256, check expiry,
 * stamp last_used_at, and audit every rejection.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const raw = req.headers['x-api-key'];
    const apiKey = Array.isArray(raw) ? raw[0] : raw;

    if (!apiKey) throw new UnauthorizedException('X-API-Key header required');

    const prefix = keyPrefixOf(apiKey);
    const record = await this.prisma.apiKey.findFirst({
      where: { keyPrefix: prefix, isActive: true },
    });

    const reject = async (reason: string, message: string, actorId?: string) => {
      await this.audit.log({
        eventType: 'AUTH_KEY_FAILED',
        actorType: 'API_KEY',
        actorId,
        actorLabel: prefix,
        endpoint: req.path,
        httpMethod: req.method,
        ipAddress: clientIp(req),
        statusCode: 401,
        extraData: { reason },
      });
      throw new UnauthorizedException(message);
    };

    if (!record || record.hashedKey !== hashApiKey(apiKey)) {
      await reject('Invalid or missing key', 'Invalid API Key');
    }
    if (record.expiresAt && record.expiresAt < new Date()) {
      await reject('Key expired', 'API Key expired', record.id);
    }

    await this.prisma.apiKey.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() },
    });

    (req as any).apiKey = record;
    return true;
  }
}
