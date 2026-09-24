import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export const ROLE_NAMES = ['admin', 'analyst', 'readonly'] as const;

export class CreateUserDto {
  @ApiProperty({ example: 'analyst1' })
  @IsString() @IsNotEmpty()
  username: string;

  /** Needs a top-level domain: `user@localhost` is rejected. */
  @ApiProperty({ example: 'analyst1@example.com' })
  @IsEmail({}, { message: 'Invalid email format' })
  email: string;

  @ApiProperty({ format: 'password', minLength: 8 })
  @IsString() @MinLength(8)
  password: string;

  @ApiPropertyOptional({ enum: ROLE_NAMES, default: 'analyst' })
  @IsOptional() @IsIn(ROLE_NAMES as unknown as string[])
  role?: string = 'analyst';
}

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'analyst1@example.com' })
  @IsOptional() @IsEmail({}, { message: 'Invalid email format' })
  email?: string;

  @ApiPropertyOptional({ format: 'password', minLength: 8 })
  @IsOptional() @IsString() @MinLength(8)
  password?: string;

  @ApiPropertyOptional({ enum: ROLE_NAMES })
  @IsOptional() @IsString()
  role?: string;

  /** False locks the account without deleting it. */
  @ApiPropertyOptional()
  @IsOptional() @IsBoolean()
  is_active?: boolean;
}
