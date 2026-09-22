import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

import { AuthUser, JwtPayload } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** bcrypt cost 12 — passlib's default, so hashes stay interchangeable. */
  static readonly BCRYPT_ROUNDS = 12;

  static hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, AuthService.BCRYPT_ROUNDS);
  }

  async authenticate(username: string, password: string): Promise<AuthUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { username },
      include: { role: true },
    });
    if (!user || !user.isActive) return null;
    if (!(await bcrypt.compare(password, user.hashedPassword))) return null;
    return user;
  }

  async issueTokens(user: { id: string; username: string }): Promise<TokenPair> {
    const base = { sub: user.id, username: user.username };
    const jwtConfig = this.config.get('jwt');

    const [access_token, refresh_token] = await Promise.all([
      this.jwt.signAsync(
        { ...base, type: 'access' },
        { expiresIn: `${jwtConfig.accessExpireMinutes}m` },
      ),
      this.jwt.signAsync(
        { ...base, type: 'refresh' },
        { expiresIn: `${jwtConfig.refreshExpireDays}d` },
      ),
    ]);

    return { access_token, refresh_token, token_type: 'bearer' };
  }

  /** Returns a fresh pair, or null when the refresh token is invalid/revoked. */
  async refresh(refreshToken: string): Promise<TokenPair | null> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken);
    } catch {
      return null;
    }
    if (payload.type !== 'refresh' || !payload.sub) return null;

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) return null;

    return this.issueTokens(user);
  }
}
