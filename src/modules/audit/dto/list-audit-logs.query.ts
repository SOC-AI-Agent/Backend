import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ListAuditLogsQuery {
  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  skip?: number = 0;

  @ApiPropertyOptional({ default: 100, minimum: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  limit?: number = 100;

  @ApiPropertyOptional({ example: 'AUTH_FAILED' })
  @IsOptional() @IsString()
  event_type?: string;

  /** Substring, case-insensitive. */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  actor_label?: string;

  /** Substring, case-insensitive. */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  ip_address?: string;

  @ApiPropertyOptional({ example: 401 })
  @IsOptional() @Type(() => Number) @IsInt()
  status_code?: number;

  /** ISO 8601. An unparseable date is ignored, not rejected. */
  @ApiPropertyOptional({ example: '2026-09-01T00:00:00Z' })
  @IsOptional() @IsString()
  date_from?: string;

  @ApiPropertyOptional({ example: '2026-09-30T23:59:59Z' })
  @IsOptional() @IsString()
  date_to?: string;
}
