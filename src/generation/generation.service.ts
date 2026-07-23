import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JobKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { StorageService } from '../storage/storage.service';
import { CREDIT_COSTS } from '../config/pricing';
import { CreateGenerationJobDto } from './dto/create-job.dto';
import { GENERATION_QUEUE } from '../jobs/queues';

/**
 * The "prompt → job queue → asset" spine shared by the Picture, Video and
 * Music/Voice modules. Credits are reserved up-front and refunded
 * automatically if the upstream provider fails.
 */
@Injectable()
export class GenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly storage: StorageService,
    @InjectQueue(GENERATION_QUEUE) private readonly queue: Queue,
  ) {}

  private costFor(dto: CreateGenerationJobDto): number {
    const base = CREDIT_COSTS[dto.kind];
    const multiplier =
      dto.kind === 'TTS'
        ? Math.max(1, Math.ceil((dto.prompt?.length ?? 0) / 500))
        : dto.count ?? 1;
    return base * multiplier;
  }

  async createJob(workspaceId: string, userId: string, dto: CreateGenerationJobDto) {
    const creditsCost = this.costFor(dto);

    const job = await this.prisma.generationJob.create({
      data: {
        workspaceId,
        createdById: userId,
        kind: dto.kind,
        creditsCost,
        input: JSON.parse(JSON.stringify(dto)),
      },
    });

    // Reserve credits atomically; idempotency key ties the spend to the job.
    await this.credits.spend(workspaceId, creditsCost, this.reasonFor(dto.kind), {
      jobId: job.id,
      idempotencyKey: `job:${job.id}`,
    });

    await this.queue.add(
      'generate',
      { jobId: job.id },
      { attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000 },
    );

    return job;
  }

  private reasonFor(kind: JobKind) {
    if (kind.startsWith('IMAGE')) return 'IMAGE_GENERATION' as const;
    if (kind.startsWith('VIDEO')) return 'VIDEO_GENERATION' as const;
    return 'AUDIO_GENERATION' as const;
  }

  async getJob(workspaceId: string, jobId: string) {
    const job = await this.prisma.generationJob.findFirst({
      where: { id: jobId, workspaceId },
      include: { assets: true },
    });
    if (!job) throw new NotFoundException('Job not found');

    const assets = await Promise.all(
      job.assets.map(async (a: any) => ({
        ...a,
        downloadUrl: await this.storage.signedDownloadUrl(a.storageKey),
      })),
    );
    return { ...job, assets };
  }

  async listJobs(workspaceId: string, take = 30, cursor?: string) {
    return this.prisma.generationJob.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
  }

  async listAssets(workspaceId: string, type?: 'IMAGE' | 'VIDEO' | 'AUDIO') {
    const assets = await this.prisma.asset.findMany({
      where: { workspaceId, ...(type ? { type } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 60,
    });
    return Promise.all(
      assets.map(async (a: any) => ({
        ...a,
        downloadUrl: await this.storage.signedDownloadUrl(a.storageKey),
      })),
    );
  }
}
