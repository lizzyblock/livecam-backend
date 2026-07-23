import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GenerationProcessor } from './generation.processor';
import { GenerationModule } from '../generation/generation.module';
import { CreditsModule } from '../credits/credits.module';
import { VoicesModule } from '../voices/voices.module';
import { GENERATION_QUEUE } from './queues';

@Module({
  imports: [
    BullModule.registerQueue({ name: GENERATION_QUEUE }),
    GenerationModule,
    CreditsModule,
    VoicesModule,
  ],
  providers: [GenerationProcessor],
})
export class JobsModule {}
