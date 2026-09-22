import { IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export const ROLE_NAMES = ['admin', 'analyst', 'readonly'] as const;

export class CreateUserDto {
  @IsString() @IsNotEmpty()
  username: string;

  @IsEmail({}, { message: 'Invalid email format' })
  email: string;

  @IsString() @MinLength(8)
  password: string;

  @IsOptional() @IsIn(ROLE_NAMES as unknown as string[])
  role?: string = 'analyst';
}

export class UpdateUserDto {
  @IsOptional() @IsEmail({}, { message: 'Invalid email format' })
  email?: string;

  @IsOptional() @IsString() @MinLength(8)
  password?: string;

  @IsOptional() @IsString()
  role?: string;

  @IsOptional() @IsBoolean()
  is_active?: boolean;
}
