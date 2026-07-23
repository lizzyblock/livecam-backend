import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, Max, Min } from 'class-validator';
import { BillingService } from './billing.service';
import { Public } from '../common/decorators/public.decorator';
import {
  AuthedMembership,
  CurrentMembership,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { User } from '@prisma/client';

class SubscribeDto {
  @IsString()
  priceId: string;
}

class TopupDto {
  @IsInt()
  @Min(100)
  @Max(100000)
  credits: number;
}

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @ApiBearerAuth()
  @Get('subscription')
  subscription(@CurrentMembership() m: AuthedMembership) {
    return this.billing.getSubscription(m.workspaceId);
  }

  @ApiBearerAuth()
  @Post('checkout/subscription')
  subscribe(
    @CurrentMembership() m: AuthedMembership,
    @CurrentUser() user: User,
    @Body() dto: SubscribeDto,
  ) {
    return this.billing.createSubscriptionCheckout(m.workspaceId, user.email, dto.priceId);
  }

  @ApiBearerAuth()
  @Post('checkout/topup')
  topup(
    @CurrentMembership() m: AuthedMembership,
    @CurrentUser() user: User,
    @Body() dto: TopupDto,
  ) {
    return this.billing.createTopupCheckout(m.workspaceId, user.email, dto.credits);
  }

  @ApiBearerAuth()
  @Post('portal')
  portal(@CurrentMembership() m: AuthedMembership) {
    return this.billing.createPortalSession(m.workspaceId);
  }

  /** Stripe webhook — raw body required for signature verification. */
  @Public()
  @Post('webhooks/stripe')
  async stripeWebhook(
    @Req() req: any,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!signature) throw new BadRequestException('Missing stripe-signature');
    const event = this.billing.constructEvent(req.rawBody, signature);
    await this.billing.handleWebhook(event);
    return { received: true };
  }
}
