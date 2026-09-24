import {
  Controller,
  Get,
  NotFoundException,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { ApiRoleAuth } from '../../common/decorators/api-docs.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ErrorResponse } from '../../common/dto/error.response';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthUser } from '../../common/types/auth-user';
import { clientIp } from '../../common/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DbSchemaResponse } from './dto/db-schema.response';

type SchemaColumn = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  ordinal_position: number;
};

@ApiTags('Internal')
@Controller('internal/db')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiRoleAuth('admin')
export class InternalController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('schema')
  @ApiOperation({
    summary: 'Table and column metadata of the database',
    description:
      'For inspecting a production schema before a migration is baselined. Off unless `DB_SCHEMA_DEBUG=true`: ' +
      'otherwise this answers 404 as if it did not exist. Columns named like a password, secret, token, hash or API key are left out. Every call is audited.',
  })
  @ApiOkResponse({ type: DbSchemaResponse })
  @ApiNotFoundResponse({ type: ErrorResponse, description: 'DB_SCHEMA_DEBUG is not true.' })
  async schema(@CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!this.config.get<boolean>('diagnostics.schemaDebug', false)) {
      throw new NotFoundException();
    }

    const columns = await this.prisma.$queryRaw<SchemaColumn[]>`
      SELECT table_name, column_name, data_type, is_nullable, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name !~* '(password|secret|token|hash|api[_-]?key)'
      ORDER BY table_name, ordinal_position
    `;

    const tableMap = new Map<string, Array<Omit<SchemaColumn, 'table_name'>>>();
    for (const column of columns) {
      const tableColumns = tableMap.get(column.table_name) ?? [];
      tableColumns.push({
        column_name: column.column_name,
        data_type: column.data_type,
        is_nullable: column.is_nullable,
        ordinal_position: column.ordinal_position,
      });
      tableMap.set(column.table_name, tableColumns);
    }

    await this.audit.log({
      eventType: 'AUDIT_EXPORTED',
      actorType: 'USER',
      actorId: user.id,
      actorLabel: user.username,
      endpoint: '/internal/db/schema',
      httpMethod: 'GET',
      ipAddress: clientIp(req),
      statusCode: 200,
      extraData: { tables: tableMap.size, redacted: true },
    });

    return {
      schema: 'public',
      generated_at: new Date().toISOString(),
      tables: [...tableMap.entries()].map(([name, tableColumns]) => ({
        name,
        columns: tableColumns,
      })),
    };
  }
}
