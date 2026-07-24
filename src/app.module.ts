import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { CreditsModule } from './credits/credits.module';
import { BillingModule } from './billing/billing.module';
import { GenerationModule } from './generation/generation.module';
import { JobsModule } from './jobs/jobs.module';
import { LivecamModule } from './livecam/livecam.module';
import { VoicesModule } from './voices/voices.module';
import { FacesModule } from './faces/faces.module';
import { MarketingModule } from './marketing/marketing.module';
import { HealthModule } from './health/health.module';
import { ClerkAuthGuard } from './common/guards/clerk-auth.guard';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('redis.url') ?? '';
        // Hosted Redis (Upstash, Aiven, Redis Cloud) is TLS-only. A plain
        // redis:// URL to a TLS endpoint is closed mid-handshake and shows up
        // as a flood of ECONNRESET rather than a clear TLS error.
        const isTls = url.startsWith('rediss://');

        return {
          connection: {
            url,
            // BullMQ holds blocking connections (BRPOPLPUSH). ioredis's
            // default of 20 retries per request kills those, producing
            // MaxRetriesPerRequestError under normal operation — BullMQ
            // requires this to be null.
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            ...(isTls ? { tls: {} } : {}),
          },
        };
      },
    }),
    PrismaModule,
    StorageModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
    CreditsModule,
    BillingModule,
    GenerationModule,
    JobsModule,
    LivecamModule,
    VoicesModule,
    FacesModule,
    MarketingModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ClerkAuthGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
export class AppModule {}
