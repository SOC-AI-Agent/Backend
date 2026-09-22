import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../types/auth-user';

/** Bearer-token auth for dashboard users. Equivalent to FastAPI's get_current_user. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const invalid = new UnauthorizedException('Invalid or expired token');

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw invalid;

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
    } catch {
      throw invalid;
    }
    if (payload.type !== 'access' || !payload.sub) throw invalid;

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: true },
    });
    if (!user || !user.isActive) throw invalid;

    (req as any).user = user;
    return true;
  }
}
