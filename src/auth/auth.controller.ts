import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createHmac, timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { Public } from '../common/decorators/public.decorator';

/**
 * Clerk webhooks (Svix-signed). Verifies the svix signature manually to
 * avoid an extra dependency.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  private verifySvix(payload: string, headers: Record<string, string | undefined>) {
    const secret = this.config.get<string>('clerk.webhookSecret') ?? '';
    const id = headers['svix-id'];
    const timestamp = headers['svix-timestamp'];
    const signature = headers['svix-signature'];
    if (!id || !timestamp || !signature) {
      throw new BadRequestException('Missing svix headers');
    }

    const secretBytes = Buffer.from(secret.replace('whsec_', ''), 'base64');
    const signedContent = `${id}.${timestamp}.${payload}`;
    const expected = createHmac('sha256', secretBytes)
      .update(signedContent)
      .digest('base64');

    const provided = signature
      .split(' ')
      .map((s) => s.split(',')[1])
      .filter(Boolean);

    const ok = provided.some((sig) => {
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!ok) throw new BadRequestException('Invalid webhook signature');
  }

  @Public()
  @Post('webhooks/clerk')
  async clerkWebhook(
    @Body() body: any,
    @Headers('svix-id') svixId: string,
    @Headers('svix-timestamp') svixTimestamp: string,
    @Headers('svix-signature') svixSignature: string,
  ) {
    this.verifySvix(JSON.stringify(body), {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    });

    if (body.type === 'user.created') {
      const d = body.data;
      await this.auth.provisionUser({
        clerkId: d.id,
        email: d.email_addresses?.[0]?.email_address,
        name: [d.first_name, d.last_name].filter(Boolean).join(' ') || undefined,
        avatarUrl: d.image_url,
        referralCode: d.unsafe_metadata?.referralCode,
      });
    }
    if (body.type === 'user.deleted') {
      await this.auth.deactivateUser(body.data.id);
    }
    return { received: true };
  }
}
