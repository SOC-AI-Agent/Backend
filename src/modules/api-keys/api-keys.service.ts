import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { generateApiKey } from '../../common/crypto';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateApiKeyDto } from './dto/api-key.dto';

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Analysts see only their own keys; admins see every key. */
  async list(actor: AuthUser) {
    const keys = await this.prisma.apiKey.findMany({
      where: actor.role.name === 'admin' ? {} : { ownerId: actor.id },
      include: { owner: true },
    });

    return keys.map((key) => ({
      id: key.id,
      name: key.name,
      key_prefix: key.keyPrefix,
      owner_username: key.owner.username,
      is_active: key.isActive,
      expires_at: key.expiresAt,
      last_used_at: key.lastUsedAt,
      created_at: key.createdAt,
    }));
  }

  /** The full key is returned here and never again — only its SHA-256 is stored. */
  async create(actor: AuthUser, dto: CreateApiKeyDto) {
    const { fullKey, prefix, hashed } = generateApiKey();
    const expiresAt = dto.expires_days
      ? new Date(Date.now() + dto.expires_days * 24 * 60 * 60 * 1000)
      : null;

    const record = await this.prisma.apiKey.create({
      data: {
        name: dto.name,
        keyPrefix: prefix,
        hashedKey: hashed,
        ownerId: actor.id,
        expiresAt,
      },
    });

    await this.audit.log({
      eventType: 'KEY_CREATED',
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.username,
      extraData: { key_name: dto.name, prefix },
    });

    return {
      id: record.id,
      name: record.name,
      key: fullKey,
      key_prefix: prefix,
      expires_at: record.expiresAt,
      created_at: record.createdAt,
    };
  }

  async revoke(actor: AuthUser, keyId: string) {
    const record = await this.prisma.apiKey.findUnique({ where: { id: keyId } });
    if (!record) throw new NotFoundException('API Key not found');
    if (actor.role.name !== 'admin' && record.ownerId !== actor.id) {
      throw new ForbiddenException('Not your key');
    }

    await this.prisma.apiKey.update({ where: { id: keyId }, data: { isActive: false } });
    await this.audit.log({
      eventType: 'KEY_REVOKED',
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.username,
      extraData: { key_id: keyId, key_prefix: record.keyPrefix },
    });
  }
}
