import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
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
  private readonly logger = new Logger(ClerkAuthGuard.name);
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  private getJwks() {
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(new URL(this.jwksUrl()));
    }
    return this.jwks;
  }

  private jwksUrl() {
    return (
      this.config.get<string>('clerk.jwksUrl') ??
      `${this.config.get<string>('clerk.issuer')}/.well-known/jwks.json`
    );
  }

  /**
   * Read the issuer out of a token without verifying it.
   *
   * Used purely for diagnostics: when key lookup fails, the single most
   * useful thing to report is which Clerk instance actually issued the
   * token, so the mismatch can be fixed in one step rather than guessed at.
   */
  private static peekIssuer(token: string): string | null {
    try {
      const payload = token.split('.')[1];
      const json = Buffer.from(payload, 'base64url').toString('utf8');
      return JSON.parse(json)?.iss ?? null;
    } catch {
      return null;
    }
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

      // The JWKS had no key matching this token's `kid` — the backend is
      // pointed at a different Clerk instance than the frontend.
      if (/JSON Web Key Set|no applicable key/i.test(message)) {
        const header: string | undefined = req.headers['authorization'];
        const actual = header
          ? ClerkAuthGuard.peekIssuer(header.slice(7))
          : null;
        const configured = this.config.get<string>('clerk.issuer');

        this.logger.error(
          `Clerk instance mismatch. Token issuer: ${actual ?? 'unknown'} | ` +
            `CLERK_ISSUER: ${configured ?? 'unset'} | JWKS: ${this.jwksUrl()}`,
        );

        throw new UnauthorizedException({
          code: 'CLERK_INSTANCE_MISMATCH',
          message:
            'Auth is misconfigured. This token was issued by ' +
            `${actual ?? 'an unknown Clerk instance'}, but the API is ` +
            `configured for ${configured ?? '(CLERK_ISSUER not set)'}. ` +
            'Set CLERK_ISSUER on the API to the value shown as the token ' +
            'issuer, and CLERK_JWKS_URL to that value + ' +
            '/.well-known/jwks.json',
          tokenIssuer: actual,
          configuredIssuer: configured ?? null,
        });
      }

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
