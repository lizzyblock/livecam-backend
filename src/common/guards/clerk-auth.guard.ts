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
import { AuthService } from '../../auth/auth.service';

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
    private readonly auth: AuthService,
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
      // Creates the user + workspace + trial credits if the webhook hasn't.
      const user = await this.auth.ensureProvisioned(clerkId);
      if (!user) throw new UnauthorizedException('Could not provision account');

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
      // Distinguish a genuinely bad/expired token from a misconfigured
      // issuer, which otherwise both surface as "please sign in again".
      const message = (e as Error)?.message ?? '';
      if (/issuer|audience|"iss"|"aud"/i.test(message)) {
        throw new UnauthorizedException({
          code: 'CLERK_ISSUER_MISMATCH',
          message:
            "Auth is misconfigured: the token's issuer doesn't match " +
            'CLERK_ISSUER on the API. Check that both frontend and backend ' +
            'use the same Clerk instance (development vs production keys).',
        });
      }
      if (/expired|"exp"/i.test(message)) {
        throw new UnauthorizedException({
          code: 'TOKEN_EXPIRED',
          message: 'Your session expired — please sign in again.',
        });
      }
      throw new UnauthorizedException({
        code: 'TOKEN_INVALID',
        message: `Could not verify your session: ${message}`,
      });
    }
  }
}
