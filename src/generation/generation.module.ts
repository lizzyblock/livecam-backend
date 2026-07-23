import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GenerationController } from './generation.controller';
import { GenerationService } from './generation.service';
import { FalImageProvider } from './providers/fal.provider';
import { ReplicateProvider } from './providers/replicate.provider';
import { CompositeVideoProvider } from './providers/video.provider';
import { CompositeAudioProvider } from './providers/audio.provider';
import { CreditsModule } from '../credits/credits.module';
import { GENERATION_QUEUE } from '../jobs/queues';

@Module({
  imports: [CreditsModule, BullModule.registerQueue({ name: GENERATION_QUEUE })],
  controllers: [GenerationController],
  providers: [
    GenerationService,
    FalImageProvider,
    ReplicateProvider,
    CompositeVideoProvider,
    CompositeAudioProvider,
  ],
  exports: [
    GenerationService,
    FalImageProvider,
    ReplicateProvider,
    CompositeVideoProvider,
    CompositeAudioProvider,
  ],
})
export class GenerationModule {}
