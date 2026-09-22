import { Injectable, Logger } from '@nestjs/common';
import { ActorType, EventType, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  eventType: EventType | keyof typeof EventType;
  actorType: ActorType | keyof typeof ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  endpoint?: string | null;
  httpMethod?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  jobId?: string | null;
  promptSnapshot?: string | null;
  aiResponseSnapshot?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  extraData?: Prisma.InputJsonValue | null;
}

/**
 * Single writer for the audit_logs table. Every auth event, request and job
 * transition goes through here — a failed write is logged but never breaks the
 * caller, same as the FastAPI audit_logger.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          eventType: entry.eventType as EventType,
          actorType: entry.actorType as ActorType,
          actorId: entry.actorId ?? null,
          actorLabel: entry.actorLabel ?? null,
          endpoint: entry.endpoint ?? null,
          httpMethod: entry.httpMethod ?? null,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
          jobId: entry.jobId ?? null,
          promptSnapshot: entry.promptSnapshot ?? null,
          aiResponseSnapshot: entry.aiResponseSnapshot ?? null,
          statusCode: entry.statusCode ?? null,
          durationMs: entry.durationMs ?? null,
          extraData: entry.extraData ?? {},
          timestamp: new Date(),
        },
      });
    } catch (err) {
      this.logger.error(`Failed to write audit entry ${entry.eventType}: ${err}`);
    }
  }
}
