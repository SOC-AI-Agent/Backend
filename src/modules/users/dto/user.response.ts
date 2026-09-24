import { ApiProperty } from '@nestjs/swagger';

export class UserResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  username: string;
  email: string;

  @ApiProperty({ enum: ['admin', 'analyst', 'readonly'] })
  role: string;

  is_active: boolean;
  created_at: Date;
}
