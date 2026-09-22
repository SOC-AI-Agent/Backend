import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class CreateApiKeyDto {
  @IsString() @IsNotEmpty()
  name: string;

  /** Omit for a key that never expires. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  expires_days?: number;
}
