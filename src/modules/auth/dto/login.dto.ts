import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'analyst1' })
  @IsString() @IsNotEmpty()
  username: string;

  @ApiProperty({ format: 'password' })
  @IsString() @IsNotEmpty()
  password: string;
}

export class RefreshDto {
  @IsString() @IsNotEmpty()
  refresh_token: string;
}
