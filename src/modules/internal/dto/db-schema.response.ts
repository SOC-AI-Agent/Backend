import { ApiProperty } from '@nestjs/swagger';

export class DbColumnResponse {
  column_name: string;

  @ApiProperty({ example: 'character varying' })
  data_type: string;

  @ApiProperty({ enum: ['YES', 'NO'] })
  is_nullable: string;

  /** 1-based position in the table. */
  ordinal_position: number;
}

export class DbTableResponse {
  name: string;

  @ApiProperty({ type: [DbColumnResponse] })
  columns: DbColumnResponse[];
}

/**
 * Table and column metadata for the `public` schema — for inspecting a production
 * database before a migration is baselined. Columns whose name looks like a
 * password, secret, token, hash or API key are left out.
 */
export class DbSchemaResponse {
  @ApiProperty({ example: 'public' })
  schema: string;

  generated_at: string;

  @ApiProperty({ type: [DbTableResponse] })
  tables: DbTableResponse[];
}
