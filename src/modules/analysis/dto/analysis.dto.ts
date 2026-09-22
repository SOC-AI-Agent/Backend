import { Type } from 'class-transformer';
import {
  IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Min, ValidateNested,
} from 'class-validator';

export class IndicatorDto {
  @IsString() @IsNotEmpty()
  type: string;

  @IsString() @IsNotEmpty()
  value: string;

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
  @IsString() @IsNotEmpty()
  alert_id: string;

  @IsString() @IsNotEmpty()
  alert_name: string;

  @IsString() @IsNotEmpty()
  raw_log: string;

  /**
   * Indicators the playbook already parsed out of its own record. Optional —
   * the worker extracts from raw_log either way — but these are better: the
   * SOAR had the structured alert, this side only receives its rendering.
   */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => IndicatorDto)
  indicators?: IndicatorDto[];
}

export class ListResultsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  skip?: number = 0;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  limit?: number = 50;

  @IsOptional() @IsString()
  status_filter?: string;
}
