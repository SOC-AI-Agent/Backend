import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Min, ValidateNested,
} from 'class-validator';

export class IndicatorDto {
  /** `ip`, `domain`, `url`, `hash` or `email` are checked against ThreatQ; anything else is kept and searched in Splunk. */
  @ApiProperty({ example: 'ip' })
  @IsString() @IsNotEmpty()
  type: string;

  @ApiProperty({ example: '45.83.122.9' })
  @IsString() @IsNotEmpty()
  value: string;

  /** Where the playbook read it from. Defaults to `soar`. */
  @ApiPropertyOptional({ example: 'dstip' })
  @IsOptional() @IsString()
  source?: string;
}

/**
 * What SOAR posts to /v1/analyze.
 *
 * There is no instruction field. The agent on the LLM server owns its own
 * system prompt — including the rules about not inventing facts and not
 * recommending actions — and caller-supplied text used to be prepended above
 * those rules, which let any API-key holder rewrite them. A playbook that
 * still sends `prompt` is not rejected: the validation pipe whitelists, so
 * the field is dropped and the request succeeds.
 */
export class AnalyzeDto {
  /** The SOAR's own id for the alert. */
  @ApiProperty({ example: 'FSR-2026-0921-001' })
  @IsString() @IsNotEmpty()
  alert_id: string;

  /** The detection's name. It is how a playbook is matched, so send it as the SIEM names it. */
  @ApiProperty({ example: 'Outbound connection blocked by perimeter firewall' })
  @IsString() @IsNotEmpty()
  alert_name: string;

  /** The event as it was logged. Indicators are extracted from it. */
  @ApiProperty({
    example:
      'date=2026-09-21 time=07:20:31 devname="FGT-01" type="traffic" subtype="forward" level="alert" ' +
      'srcip=10.1.100.11 srcport=51020 dstip=45.83.122.9 dstport=8443 proto=6 action="blocked" service="HTTPS" ' +
      'dstcountry="Russia" sentbyte=2000 rcvdbyte=0 user="jdoe"',
  })
  @IsString() @IsNotEmpty()
  raw_log: string;

  /**
   * Indicators the playbook already parsed out of its own record. Optional —
   * the worker extracts from raw_log either way — but these are better: the
   * SOAR had the structured alert, this side only receives its rendering.
   */
  @ApiPropertyOptional({ type: [IndicatorDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => IndicatorDto)
  indicators?: IndicatorDto[];
}

export class ListResultsQuery {
  /** Rows to skip. */
  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  skip?: number = 0;

  /** Rows to return. */
  @ApiPropertyOptional({ default: 50, minimum: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  limit?: number = 50;

  /** Only jobs in this state (case-insensitive). */
  @ApiPropertyOptional({ enum: ['pending', 'processing', 'completed', 'failed'] })
  @IsOptional() @IsString()
  status_filter?: string;
}
