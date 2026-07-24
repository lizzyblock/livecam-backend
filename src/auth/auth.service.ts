import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { customAlphabet } from 'nanoid';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import {
  REFERRAL_BONUS_CREDITS,
  TRIAL_CREDITS,
  TRIAL_LIVECAM_SECONDS,
} from '../config/pricing';

const slugId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Provision on first authenticated request ("just in time").
   *
   * The Clerk webhook is the fast path, but webhooks get misconfigured, fire
   * out of order, or fail silently — and the symptom is a user who can sign
   * in and then gets 401 on everything, which is baffling. Treating the
   * verified JWT as sufficient proof of identity removes that whole class of
   * problem; the webhook becomes an optimisation rather than a requirement.
   */
  async ensureProvisioned(clerkId: string) {
    const existing = await this.prisma.user.findUnique({
      where: { clerkId },
      include: { memberships: { include: { workspace: true } } },
    });
    if (existing) return existing;

    const profile = await this.fetchClerkProfile(clerkId);
    this.logger.log(`JIT-provisioning ${clerkId} (${profile.email})`);

    await this.provisionUser({
      clerkId,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });

    return this.prisma.user.findUnique({
      where: { clerkId },
      include: { memberships: { include: { workspace: true } } },
    });
  }

  /** Clerk's session JWT carries no email by default, so fetch the profile. */
  private async fetchClerkProfile(clerkId: string): Promise<{
    email: string;
    name?: string;
    avatarUrl?: string;
  }> {
    const secret = this.config.get<string>('clerk.secretKey');
    if (!secret) {
      // Without the secret we can't read the profile — fall back to a
      // placeholder so the account still works rather than blocking login.
      this.logger.warn(
        'CLERK_SECRET_KEY not set — provisioning with a placeholder email. ' +
          'Set it so accounts carry real addresses.',
      );
      return { email: `${clerkId}@placeholder.local` };
    }

    const res = await fetch(`https://api.clerk.com/v1/users/${clerkId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!res.ok) {
      throw new Error(`Could not read Clerk profile (${res.status})`);
    }
    const body: any = await res.json();
    const primaryId = body.primary_email_address_id;
    const email =
      body.email_addresses?.find((e: any) => e.id === primaryId)?.email_address ??
      body.email_addresses?.[0]?.email_address ??
      `${clerkId}@placeholder.local`;

    return {
      email,
      name: [body.first_name, body.last_name].filter(Boolean).join(' ') || undefined,
      avatarUrl: body.image_url,
    };
  }

  /**
   * Provision a local user + personal workspace when Clerk reports a signup.
   * If the signup carried a referral code, credit the referrer.
   */
  async provisionUser(input: {
    clerkId: string;
    email: string;
    name?: string;
    avatarUrl?: string;
    referralCode?: string;
  }) {
    const existing = await this.prisma.user.findUnique({
      where: { clerkId: input.clerkId },
    });
    if (existing) return existing;

    let referredById: string | undefined;
    if (input.referralCode) {
      const referrer = await this.prisma.user.findUnique({
        where: { referralCode: input.referralCode },
        include: { memberships: true },
      });
      if (referrer) {
        referredById = referrer.id;
        const refWorkspace = referrer.memberships[0]?.workspaceId;
        if (refWorkspace) {
          await this.credits.grant(
            refWorkspace,
            REFERRAL_BONUS_CREDITS,
            'REFERRAL_BONUS',
            { idempotencyKey: `referral:${input.clerkId}` },
          );
        }
      }
    }

    const user = await this.prisma.user.create({
      data: {
        clerkId: input.clerkId,
        email: input.email,
        name: input.name,
        avatarUrl: input.avatarUrl,
        referredById,
        memberships: {
          create: {
            role: 'OWNER',
            workspace: {
              create: {
                name: input.name ? `${input.name}'s Workspace` : 'My Workspace',
                slug: `ws-${slugId()}`,
                creditBalance: {
                  create: {
                    credits: TRIAL_CREDITS,
                    livecamSeconds: TRIAL_LIVECAM_SECONDS,
                  },
                },
              },
            },
          },
        },
      },
    });
    this.logger.log(`Provisioned user ${user.id} (${user.email})`);
    return user;
  }

  async deactivateUser(clerkId: string) {
    // Soft approach: keep data for billing history; detach auth identity.
    this.logger.log(`Clerk user deleted: ${clerkId}`);
  }
}
