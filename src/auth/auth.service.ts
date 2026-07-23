import { Injectable, Logger } from '@nestjs/common';
import { customAlphabet } from 'nanoid';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { REFERRAL_BONUS_CREDITS } from '../config/pricing';

const slugId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
  ) {}

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
                creditBalance: { create: { credits: 25 } }, // free trial credits
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
