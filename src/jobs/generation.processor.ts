import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AssetType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CreditsService } from '../credits/credits.service';
import { FalImageProvider } from '../generation/providers/fal.provider';
import { CompositeVideoProvider } from '../generation/providers/video.provider';
import { CompositeAudioProvider } from '../generation/providers/audio.provider';
import { GeneratedFile } from '../generation/providers/provider.interface';
import { GENERATION_QUEUE } from './queues';
import { VoicesService } from '../voices/voices.service';

/**
 * BullMQ worker that executes generation jobs: routes to the right provider,
 * ingests upstream files into Storj, records Assets, and refunds credits on
 * terminal failure.
 */
@Processor(GENERATION_QUEUE, { concurrency: 8 })
export class GenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(GenerationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly credits: CreditsService,
    private readonly images: FalImageProvider,
    private readonly videos: CompositeVideoProvider,
    private readonly audio: CompositeAudioProvider,
    private readonly voices: VoicesService,
  ) {
    super();
  }

  async process(job: Job<{ jobId: string }>): Promise<void> {
    const record = await this.prisma.generationJob.findUnique({
      where: { id: job.data.jobId },
    });
    if (!record || record.status === 'CANCELED') return;

    await this.prisma.generationJob.update({
      where: { id: record.id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    const input = record.input as any;

    try {
      const { files, assetType, provider, ext } = await this.route(record.kind, input, record.workspaceId);

      const assets = [];
      for (const file of files) {
        const key = this.storage.buildKey(
          record.workspaceId,
          assetType.toLowerCase() as 'image' | 'video' | 'audio',
          ext,
        );
        const { sizeBytes } = await this.storage.ingestFromUrl(key, file.url, file.mimeType);
        assets.push({
          workspaceId: record.workspaceId,
          jobId: record.id,
          type: assetType,
          storageKey: key,
          mimeType: file.mimeType,
          sizeBytes,
          width: file.width,
          height: file.height,
          durationMs: file.durationMs,
        });
      }

      await this.prisma.$transaction([
        this.prisma.asset.createMany({ data: assets }),
        this.prisma.generationJob.update({
          where: { id: record.id },
          data: {
            status: 'SUCCEEDED',
            provider,
            finishedAt: new Date(),
            output: { assetCount: assets.length },
          },
        }),
      ]);
    } catch (err) {
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      this.logger.error(
        `Job ${record.id} failed (attempt ${job.attemptsMade + 1}): ${(err as Error).message}`,
      );

      if (isFinalAttempt) {
        await this.prisma.generationJob.update({
          where: { id: record.id },
          data: {
            status: 'FAILED',
            error: (err as Error).message,
            finishedAt: new Date(),
          },
        });
        // Give the user their credits back — failed jobs must never bill.
        await this.credits.refundJob(record.workspaceId, record.id, record.creditsCost);
      }
      throw err;
    }
  }

  private async route(
    kind: string,
    input: any,
    workspaceId: string,
  ): Promise<{ files: GeneratedFile[]; assetType: AssetType; provider: string; ext: string }> {
    switch (kind) {
      case 'IMAGE_GENERATE':
        return {
          files: await this.images.generate({
            prompt: input.prompt,
            count: input.count,
            quality: input.options?.quality,
            width: input.options?.width,
            height: input.options?.height,
          }),
          assetType: 'IMAGE',
          provider: this.images.name,
          ext: 'png',
        };
      case 'IMAGE_EDIT':
        return {
          files: await this.images.edit({
            prompt: input.prompt,
            imageUrl: input.sourceAssetUrl,
            maskUrl: input.maskAssetUrl,
          }),
          assetType: 'IMAGE',
          provider: this.images.name,
          ext: 'png',
        };
      case 'IMAGE_UPSCALE':
        return {
          files: await this.images.upscale(input.sourceAssetUrl, input.options?.scale ?? 2),
          assetType: 'IMAGE',
          provider: this.images.name,
          ext: 'png',
        };
      case 'IMAGE_BG_REMOVE':
        return {
          files: await this.images.removeBackground(input.sourceAssetUrl),
          assetType: 'IMAGE',
          provider: this.images.name,
          ext: 'png',
        };
      case 'VIDEO_TEXT_TO_VIDEO':
        return {
          files: await this.videos.textToVideo({
            prompt: input.prompt,
            durationSeconds: input.durationSeconds,
            aspectRatio: input.options?.aspectRatio,
          }),
          assetType: 'VIDEO',
          provider: this.videos.name,
          ext: 'mp4',
        };
      case 'VIDEO_IMAGE_TO_VIDEO':
        return {
          files: await this.videos.imageToVideo({
            imageUrl: input.sourceAssetUrl,
            prompt: input.prompt,
            durationSeconds: input.durationSeconds,
          }),
          assetType: 'VIDEO',
          provider: this.videos.name,
          ext: 'mp4',
        };
      case 'TTS': {
        // voiceId is a Voice library id — resolve it to the provider's id so
        // cloned voices and stock voices work identically.
        let providerVoiceId: string | undefined;
        if (input.voiceId) {
          const voice = await this.voices.resolveProviderVoice(workspaceId, input.voiceId);
          providerVoiceId = voice.providerVoiceId;
        }
        return {
          files: await this.audio.tts({
            text: input.prompt,
            voiceId: providerVoiceId,
            premium: input.options?.premium,
          }),
          assetType: 'AUDIO',
          provider: this.audio.name,
          ext: 'mp3',
        };
      }
      case 'MUSIC_GENERATE':
        return {
          files: await this.audio.music({
            prompt: input.prompt,
            durationSeconds: input.durationSeconds,
          }),
          assetType: 'AUDIO',
          provider: this.audio.name,
          ext: 'mp3',
        };
      default:
        throw new Error(`Unsupported job kind: ${kind}`);
    }
  }
}
