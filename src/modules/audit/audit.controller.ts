import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

import { ApiRoleAuth } from '../../common/decorators/api-docs.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from './audit.service';
import { AuditLogListResponse } from './dto/audit-log.response';
import { ListAuditLogsQuery } from './dto/list-audit-logs.query';

const CSV_COLUMNS = [
  'id',
  'timestamp',
  'event_type',
  'actor_type',
  'actor_label',
  'endpoint',
  'http_method',
  'ip_address',
  'job_id',
  'status_code',
  'duration_ms',
];

@ApiTags('Admin')
@Controller('admin/audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiRoleAuth('admin')
export class AuditController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles('admin')
  @ApiOperation({ summary: 'Search the audit log', description: 'Newest first. Every filter is optional.' })
  @ApiOkResponse({ type: AuditLogListResponse })
  async list(@Query() query: ListAuditLogsQuery) {
    const where = this.buildWhere(query);
    const [total, items] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: query.skip ?? 0,
        take: query.limit ?? 100,
      }),
    ]);

    return {
      total,
      items: items.map((log) => ({
        id: Number(log.id),
        event_type: log.eventType,
        actor_type: log.actorType.toLowerCase(),
        actor_label: log.actorLabel,
        endpoint: log.endpoint,
        http_method: log.httpMethod,
        ip_address: log.ipAddress,
        job_id: log.jobId,
        prompt_snapshot: log.promptSnapshot,
        ai_response_snapshot: log.aiResponseSnapshot,
        status_code: log.statusCode,
        duration_ms: log.durationMs,
        extra_data: log.extraData,
        timestamp: log.timestamp,
      })),
    };
  }

  @Get('export')
  @Roles('admin')
  @ApiOperation({ summary: 'Export the audit log as CSV', description: 'The newest 10,000 entries, without the prompt and response snapshots. The export is itself audited.' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'A CSV file.', schema: { type: 'string', format: 'binary' } })
  async export(@CurrentUser() user: AuthUser, @Res() res: Response) {
    const logs = await this.prisma.auditLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: 10000,
    });

    const rows = logs.map((log) =>
      [
        Number(log.id),
        log.timestamp.toISOString(),
        log.eventType,
        log.actorType.toLowerCase(),
        log.actorLabel,
        log.endpoint,
        log.httpMethod,
        log.ipAddress,
        log.jobId,
        log.statusCode,
        log.durationMs,
      ]
        .map(csvCell)
        .join(','),
    );

    await this.audit.log({
      eventType: 'AUDIT_EXPORTED',
      actorType: 'USER',
      actorId: user.id,
      actorLabel: user.username,
      extraData: { records_count: logs.length },
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=audit_logs.csv');
    res.send([CSV_COLUMNS.join(','), ...rows].join('\n'));
  }

  private buildWhere(query: ListAuditLogsQuery): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {};

    if (query.event_type) where.eventType = query.event_type as any;
    if (query.actor_label) where.actorLabel = { contains: query.actor_label, mode: 'insensitive' };
    if (query.ip_address) where.ipAddress = { contains: query.ip_address, mode: 'insensitive' };
    if (query.status_code !== undefined) where.statusCode = query.status_code;

    const from = parseDate(query.date_from);
    const to = parseDate(query.date_to);
    if (from || to) {
      where.timestamp = { ...(from && { gte: from }), ...(to && { lte: to }) };
    }
    return where;
  }
}

/** Invalid dates are ignored rather than rejected, as the FastAPI filter did. */
function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
