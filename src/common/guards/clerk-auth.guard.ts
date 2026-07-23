import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Verifies Clerk-issued JWTs against Clerk's JWKS endpoint and attaches
 * the local User + active workspace membership to the request.
 */
@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  private getJwks() {
    if (!this.jwks) {
      const url =
        this.config.get<string>('clerk.jwksUrl') ??
        `${this.config.get<string>('clerk.issuer')}/.well-known/jwks.json`;
      this.jwks = createRemoteJWKSet(new URL(url));
    }
    return this.jwks;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const token = header.slice(7);
      const { payload } = await jwtVerify(token, this.getJwks(), {
        issuer: this.config.get<string>('clerk.issuer'),
      });

      const clerkId = payload.sub as string;
      const user = await this.prisma.user.findUnique({
        where: { clerkId },
        include: { memberships: { include: { workspace: true } } },
      });
      if (!user) throw new UnauthorizedException('User not provisioned');

      req.user = user;
      const workspaceId =
        (req.headers['x-workspace-id'] as string | undefined) ??
        user.memberships[0]?.workspaceId;
      req.membership = user.memberships.find((m: any) => m.workspaceId === workspaceId);
      if (!req.membership) {
        throw new UnauthorizedException('No workspace access');
      }
      return true;
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw new UnauthorizedException('Invalid token');
    }
  }
}
