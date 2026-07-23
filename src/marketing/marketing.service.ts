import { Injectable, NotFoundException } from '@nestjs/common';
import { AdPlatform } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Marketing & Ads — built strictly on official platform APIs
 * (Meta Marketing API, TikTok Ads API, Google Ads API). This service owns
 * the local mirror of ad accounts/campaigns; per-platform sync adapters
 * plug in behind `syncCampaigns` as OAuth apps get approved.
 */
@Injectable()
export class MarketingService {
  constructor(private readonly prisma: PrismaService) {}

  async connectAccount(
    workspaceId: string,
    input: {
      platform: AdPlatform;
      externalId: string;
      displayName?: string;
      accessToken: string;
      refreshToken?: string;
      expiresAt?: Date;
    },
  ) {
    return this.prisma.adAccount.upsert({
      where: {
        workspaceId_platform_externalId: {
          workspaceId,
          platform: input.platform,
          externalId: input.externalId,
        },
      },
      create: { workspaceId, ...input },
      update: {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAt,
        displayName: input.displayName,
      },
    });
  }

  async listAccounts(workspaceId: string) {
    return this.prisma.adAccount.findMany({
      where: { workspaceId },
      select: {
        id: true,
        platform: true,
        externalId: true,
        displayName: true,
        createdAt: true,
        campaigns: { select: { id: true, name: true, status: true, spendCents: true } },
      },
    });
  }

  async listCampaigns(workspaceId: string, adAccountId: string) {
    const account = await this.prisma.adAccount.findFirst({
      where: { id: adAccountId, workspaceId },
    });
    if (!account) throw new NotFoundException('Ad account not found');
    return this.prisma.adCampaign.findMany({
      where: { adAccountId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
