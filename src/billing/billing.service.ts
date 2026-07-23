import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PlanTier, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { PLANS } from '../config/pricing';

const TIER_BY_PRICE_ENV: Array<{ env: string; tier: PlanTier }> = [
  { env: 'stripe.prices.starter', tier: 'STARTER' },
  { env: 'stripe.prices.creator', tier: 'CREATOR' },
  { env: 'stripe.prices.studio', tier: 'STUDIO' },
];

@Injectable()
export class BillingService {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
  ) {
    this.stripe = new Stripe(config.get<string>('stripe.secretKey') ?? 'sk_test_placeholder');
  }

  private tierForPrice(priceId: string): PlanTier {
    for (const { env, tier } of TIER_BY_PRICE_ENV) {
      if (this.config.get<string>(env) === priceId) return tier;
    }
    return 'AGENCY'; // custom-negotiated prices map to Agency
  }

  private async ensureCustomer(workspaceId: string, email: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw new NotFoundException('Workspace not found');
    if (ws.stripeCustomerId) return ws.stripeCustomerId;

    const customer = await this.stripe.customers.create({
      email,
      metadata: { workspaceId },
    });
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { stripeCustomerId: customer.id },
    });
    return customer.id;
  }

  /** Checkout for a subscription tier. */
  async createSubscriptionCheckout(workspaceId: string, email: string, priceId: string) {
    const customer = await this.ensureCustomer(workspaceId, email);
    const frontend = this.config.get<string>('frontendUrl');

    const session = await this.stripe.checkout.sessions.create({
      customer,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${frontend}/dashboard/billing?status=success`,
      cancel_url: `${frontend}/dashboard/billing?status=canceled`,
      subscription_data: { metadata: { workspaceId } },
      allow_promotion_codes: true,
    });
    return { url: session.url };
  }

  /** Checkout for a one-off credit top-up. */
  async createTopupCheckout(workspaceId: string, email: string, credits: number) {
    if (credits < 100 || credits > 100000) {
      throw new BadRequestException('Top-up must be between 100 and 100,000 credits');
    }
    const customer = await this.ensureCustomer(workspaceId, email);
    const frontend = this.config.get<string>('frontendUrl');

    const session = await this.stripe.checkout.sessions.create({
      customer,
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: 2, // $0.02 per credit — tune to your margin
            product_data: { name: 'LiveCam credit top-up' },
          },
          quantity: credits,
        },
      ],
      success_url: `${frontend}/dashboard/billing?status=topup-success`,
      cancel_url: `${frontend}/dashboard/billing?status=canceled`,
      metadata: { workspaceId, kind: 'credit_topup', credits: String(credits) },
    });
    return { url: session.url };
  }

  /** Stripe Customer Portal for self-serve plan management. */
  async createPortalSession(workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws?.stripeCustomerId) throw new NotFoundException('No billing profile yet');
    const session = await this.stripe.billingPortal.sessions.create({
      customer: ws.stripeCustomerId,
      return_url: `${this.config.get('frontendUrl')}/dashboard/billing`,
    });
    return { url: session.url };
  }

  async getSubscription(workspaceId: string) {
    return this.prisma.subscription.findUnique({ where: { workspaceId } });
  }

  // ───────────── Webhook handling ─────────────

  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.config.get<string>('stripe.webhookSecret') ?? '',
    );
  }

  async handleWebhook(event: Stripe.Event) {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.kind === 'credit_topup') {
          await this.credits.grant(
            session.metadata.workspaceId,
            parseInt(session.metadata.credits, 10),
            'TOPUP_PURCHASE',
            { idempotencyKey: `topup:${session.id}` },
          );
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        await this.syncSubscription(event.data.object as Stripe.Subscription);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await this.prisma.subscription.updateMany({
          where: { stripeSubscriptionId: sub.id },
          data: { status: 'CANCELED' },
        });
        break;
      }
      case 'invoice.paid': {
        // Renewal → grant the month's credits + LiveCam minutes.
        const invoice = event.data.object as Stripe.Invoice;
        const subId =
          typeof (invoice as any).subscription === 'string'
            ? ((invoice as any).subscription as string)
            : (invoice as any).subscription?.id;
        if (!subId) break;
        const sub = await this.prisma.subscription.findUnique({
          where: { stripeSubscriptionId: subId },
        });
        if (!sub) break;

        await this.credits.grant(sub.workspaceId, sub.monthlyCredits, 'SUBSCRIPTION_GRANT', {
          idempotencyKey: `invoice:${invoice.id}`,
          metadata: { invoiceId: invoice.id ?? null },
        });
        await this.credits.grantLivecamSeconds(
          sub.workspaceId,
          sub.monthlyLivecamMinutes * 60,
        );
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId =
          typeof (invoice as any).subscription === 'string'
            ? ((invoice as any).subscription as string)
            : (invoice as any).subscription?.id;
        if (subId) {
          await this.prisma.subscription.updateMany({
            where: { stripeSubscriptionId: subId },
            data: { status: 'PAST_DUE' },
          });
        }
        break;
      }
      default:
        this.logger.debug(`Unhandled Stripe event: ${event.type}`);
    }
  }

  private async syncSubscription(sub: Stripe.Subscription) {
    const workspaceId = sub.metadata?.workspaceId;
    if (!workspaceId) {
      this.logger.warn(`Subscription ${sub.id} missing workspaceId metadata`);
      return;
    }
    const priceId = sub.items.data[0]?.price.id ?? '';
    const tier = this.tierForPrice(priceId);
    const plan = PLANS[tier];

    const statusMap: Record<string, SubscriptionStatus> = {
      active: 'ACTIVE',
      trialing: 'TRIALING',
      past_due: 'PAST_DUE',
      canceled: 'CANCELED',
      incomplete: 'INCOMPLETE',
      incomplete_expired: 'INCOMPLETE',
      unpaid: 'PAST_DUE',
      paused: 'CANCELED',
    };

    const item = sub.items.data[0] as any;
    const periodStart = item?.current_period_start ?? (sub as any).current_period_start;
    const periodEnd = item?.current_period_end ?? (sub as any).current_period_end;

    await this.prisma.subscription.upsert({
      where: { stripeSubscriptionId: sub.id },
      create: {
        workspaceId,
        stripeSubscriptionId: sub.id,
        stripePriceId: priceId,
        tier,
        status: statusMap[sub.status] ?? 'INCOMPLETE',
        currentPeriodStart: new Date(periodStart * 1000),
        currentPeriodEnd: new Date(periodEnd * 1000),
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        monthlyCredits: plan.monthlyCredits,
        monthlyLivecamMinutes: plan.monthlyLivecamMinutes,
        seats: plan.seats,
      },
      update: {
        stripePriceId: priceId,
        tier,
        status: statusMap[sub.status] ?? 'INCOMPLETE',
        currentPeriodStart: new Date(periodStart * 1000),
        currentPeriodEnd: new Date(periodEnd * 1000),
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        monthlyCredits: plan.monthlyCredits,
        monthlyLivecamMinutes: plan.monthlyLivecamMinutes,
        seats: plan.seats,
      },
    });
  }
}
