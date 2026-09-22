import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ListAuditLogsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  skip?: number = 0;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  limit?: number = 100;

  @IsOptional() @IsString()
  event_type?: string;

  @IsOptional() @IsString()
  actor_label?: string;

  @IsOptional() @IsString()
  ip_address?: string;

  @IsOptional() @Type(() => Number) @IsInt()
  status_code?: number;

  @IsOptional() @IsString()
  date_from?: string;

  @IsOptional() @IsString()
  date_to?: string;
}
