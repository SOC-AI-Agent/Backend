import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Retention cleanup. Registered only in the worker process so a multi-replica
 * API deployment cannot run it several times over.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  @Cron(
    `${Number.parseInt(process.env.CLEANUP_MINUTE ?? '0', 10)} ` +
      `${Number.parseInt(process.env.CLEANUP_HOUR ?? '2', 10)} * * *`,
  )
  async cleanup(): Promise<void> {
    const { jobsDays, auditDays } = this.config.get('retention');
    const now = Date.now();
    const jobCutoff = new Date(now - jobsDays * 86_400_000);
    const auditCutoff = new Date(now - auditDays * 86_400_000);

    try {
      // Audit logs first: they reference ai_jobs.
      const logs = await this.prisma.auditLog.deleteMany({
        where: { timestamp: { lt: auditCutoff } },
      });
      const jobs = await this.prisma.aiJob.deleteMany({
        where: { createdAt: { lt: jobCutoff } },
      });

      await this.audit.log({
        eventType: 'SYSTEM_CLEANUP',
        actorType: 'SYSTEM',
        actorLabel: 'Maintenance Service',
        extraData: {
          jobs_deleted: jobs.count,
          logs_deleted: logs.count,
          retention_jobs_days: jobsDays,
          retention_audit_days: auditDays,
        },
      });

      this.logger.log(
        `Maintenance: removed ${jobs.count} jobs and ${logs.count} audit logs ` +
          `(retention jobs=${jobsDays}d audit=${auditDays}d)`,
      );
    } catch (err) {
      this.logger.error(`Maintenance failed: ${err}`);
    }
  }
}
