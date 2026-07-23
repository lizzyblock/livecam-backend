import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { LedgerReason, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export class InsufficientCreditsError extends BadRequestException {
  constructor(required: number, available: number) {
    super({
      code: 'INSUFFICIENT_CREDITS',
      message: `This action costs ${required} credits but only ${available} are available.`,
      required,
      available,
    });
  }
}

/**
 * Double-entry-style credit ledger. Every balance change is written as an
 * immutable ledger row inside the same transaction that mutates the cached
 * balance, so the balance can always be rebuilt from the ledger.
 */
@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getBalance(workspaceId: string) {
    return this.prisma.creditBalance.upsert({
      where: { workspaceId },
      create: { workspaceId },
      update: {},
    });
  }

  /** Atomically deduct credits; throws if the balance would go negative. */
  async spend(
    workspaceId: string,
    amount: number,
    reason: LedgerReason,
    opts: { jobId?: string; idempotencyKey?: string; metadata?: Prisma.JsonObject } = {},
  ) {
    if (amount <= 0) throw new BadRequestException('Spend amount must be positive');

    return this.prisma.$transaction(async (tx: any) => {
      if (opts.idempotencyKey) {
        const existing = await tx.creditLedgerEntry.findUnique({
          where: { idempotencyKey: opts.idempotencyKey },
        });
        if (existing) return existing;
      }

      const updated = await tx.creditBalance.updateMany({
        where: { workspaceId, credits: { gte: amount } },
        data: { credits: { decrement: amount } },
      });
      if (updated.count === 0) {
        const bal = await tx.creditBalance.findUnique({ where: { workspaceId } });
        throw new InsufficientCreditsError(amount, bal?.credits ?? 0);
      }

      return tx.creditLedgerEntry.create({
        data: {
          workspaceId,
          delta: -amount,
          reason,
          jobId: opts.jobId,
          idempotencyKey: opts.idempotencyKey,
          metadata: opts.metadata,
        },
      });
    });
  }

  /** Grant credits (subscription renewal, top-up, referral bonus, refund). */
  async grant(
    workspaceId: string,
    amount: number,
    reason: LedgerReason,
    opts: { idempotencyKey?: string; metadata?: Prisma.JsonObject } = {},
  ) {
    if (amount <= 0) throw new BadRequestException('Grant amount must be positive');

    return this.prisma.$transaction(async (tx: any) => {
      if (opts.idempotencyKey) {
        const existing = await tx.creditLedgerEntry.findUnique({
          where: { idempotencyKey: opts.idempotencyKey },
        });
        if (existing) return existing;
      }

      await tx.creditBalance.upsert({
        where: { workspaceId },
        create: { workspaceId, credits: amount },
        update: { credits: { increment: amount } },
      });

      return tx.creditLedgerEntry.create({
        data: {
          workspaceId,
          delta: amount,
          reason,
          idempotencyKey: opts.idempotencyKey,
          metadata: opts.metadata,
        },
      });
    });
  }

  /** Refund a spend (e.g. when a generation job fails upstream). */
  async refundJob(workspaceId: string, jobId: string, amount: number) {
    this.logger.log(`Refunding ${amount} credits for failed job ${jobId}`);
    return this.grant(workspaceId, amount, 'REFUND', {
      idempotencyKey: `refund:${jobId}`,
      metadata: { jobId },
    });
  }

  async grantLivecamSeconds(workspaceId: string, seconds: number) {
    await this.prisma.creditBalance.upsert({
      where: { workspaceId },
      create: { workspaceId, livecamSeconds: seconds },
      update: { livecamSeconds: { increment: seconds } },
    });
  }

  async consumeLivecamSeconds(workspaceId: string, seconds: number): Promise<boolean> {
    const res = await this.prisma.creditBalance.updateMany({
      where: { workspaceId, livecamSeconds: { gte: seconds } },
      data: { livecamSeconds: { decrement: seconds } },
    });
    return res.count > 0;
  }

  async history(workspaceId: string, take = 50, cursor?: string) {
    return this.prisma.creditLedgerEntry.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
  }
}
