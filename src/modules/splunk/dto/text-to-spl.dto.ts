import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * One requirement for Splunk's Text-to-SPL, as stage 1 would hand it over —
 * typed by hand, to see what SPL Splunk writes for it.
 */
export class TextToSplDto {
  /** The question in plain language: what to find out, and about which value. */
  @ApiProperty({ example: 'Failed login attempts for user jdoe in the last 24 hours' })
  @IsString() @IsNotEmpty() @MaxLength(2000)
  requirement: string;

  /** Where to search, as the catalogue would aim it. Left out: Text-to-SPL chooses. */
  @ApiPropertyOptional({ example: 'main' })
  @IsOptional() @IsString() @MaxLength(200)
  index?: string;

  @ApiPropertyOptional({ example: 'WinEventLog' })
  @IsOptional() @IsString() @MaxLength(200)
  sourcetype?: string;

  /** Details from the alert, as the requirements agent lists them under a question. */
  @ApiPropertyOptional({ example: { user: 'jdoe', source: '45.83.122.9' } })
  @IsOptional() @IsObject()
  details?: Record<string, string>;

  /** A Splunk time modifier or epoch seconds. Default `-24h`. */
  @ApiPropertyOptional({ example: '-24h' })
  @IsOptional() @IsString() @MaxLength(50)
  earliest?: string;

  /** A Splunk time modifier or epoch seconds. Default `now`. */
  @ApiPropertyOptional({ example: 'now' })
  @IsOptional() @IsString() @MaxLength(50)
  latest?: string;
}
