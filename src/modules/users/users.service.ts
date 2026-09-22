import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Role, User } from '@prisma/client';

import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const users = await this.prisma.user.findMany({ include: { role: true } });
    return users.map(toUserResponse);
  }

  async create(actor: AuthUser, dto: CreateUserDto) {
    const exists = await this.prisma.user.findUnique({ where: { username: dto.username } });
    if (exists) throw new BadRequestException('Username already exists');

    const role = await this.requireRole(dto.role ?? 'analyst');
    const user = await this.prisma.user.create({
      data: {
        username: dto.username,
        email: dto.email,
        hashedPassword: await AuthService.hashPassword(dto.password),
        roleId: role.id,
      },
      include: { role: true },
    });

    await this.audit.log({
      eventType: 'USER_CREATED',
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.username,
      extraData: { new_user: dto.username, role: role.name },
    });

    return toUserResponse(user);
  }

  async update(actor: AuthUser, userId: string, dto: UpdateUserDto) {
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException('User not found');

    const data: Record<string, unknown> = {};
    const changes: string[] = [];

    if (dto.password) {
      data.hashedPassword = await AuthService.hashPassword(dto.password);
      changes.push('password');
    }
    if (dto.email) {
      data.email = dto.email;
      changes.push('email');
    }
    if (dto.is_active !== undefined) {
      data.isActive = dto.is_active;
      changes.push('is_active');
    }
    if (dto.role) {
      data.roleId = (await this.requireRole(dto.role)).id;
      changes.push('role');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      include: { role: true },
    });

    await this.audit.log({
      eventType: 'USER_UPDATED',
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.username,
      extraData: { target_user: updated.username, changes },
    });

    return toUserResponse(updated);
  }

  async remove(actor: AuthUser, userId: string) {
    if (userId === actor.id) throw new BadRequestException('Cannot delete yourself');

    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException('User not found');

    await this.prisma.user.delete({ where: { id: userId } });
    await this.audit.log({
      eventType: 'USER_DELETED',
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.username,
      extraData: { deleted_user: target.username },
    });
  }

  private async requireRole(name: string): Promise<Role> {
    const role = await this.prisma.role.findUnique({ where: { name } });
    if (!role) throw new BadRequestException(`Role '${name}' not found`);
    return role;
  }
}

export function toUserResponse(user: User & { role: Role }) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role.name,
    is_active: user.isActive,
    created_at: user.createdAt,
  };
}
