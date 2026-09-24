import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class CreateApiKeyDto {
  /** What the key is for — shown in the list, so name the caller (`fortisoar-prod`). */
  @ApiProperty({ example: 'fortisoar-prod' })
  @IsString() @IsNotEmpty()
  name: string;

  /** Omit for a key that never expires. */
  @ApiPropertyOptional({ example: 90, minimum: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  expires_days?: number;
}
