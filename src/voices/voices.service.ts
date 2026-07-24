import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { StorageService } from '../storage/storage.service';
import { CREDIT_COSTS } from '../config/pricing';

/**
 * Voice library: stock voices (workspaceId = null) shared by everyone, plus
 * per-workspace cloned voices. Cloning uses ElevenLabs Instant Voice Cloning;
 * the same providerVoiceId then works for TTS renders *and* for the real-time
 * speech-to-speech conversion the LiveCam GPU worker applies to the mic track.
 */
@Injectable()
export class VoicesService implements OnModuleInit {
  private readonly logger = new Logger(VoicesService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly storage: StorageService,
  ) {}

  async onModuleInit() {
    // Idempotent; skipped quietly if migrations haven't run yet.
    await this.seedStockVoices().catch(() => undefined);
  }

  /** Stock voices + this workspace's cloned voices, with preview URLs. */
  async list(workspaceId: string) {
    const voices = await this.prisma.voice.findMany({
      where: { OR: [{ workspaceId: null }, { workspaceId }] },
      orderBy: [{ isCloned: 'asc' }, { createdAt: 'desc' }],
    });
    return Promise.all(
      voices.map(async (v: any) => ({
        ...v,
        previewUrl: v.previewKey
          ? await this.storage.signedDownloadUrl(v.previewKey, 3600).catch(() => null)
          : null,
      })),
    );
  }

  /**
   * A short spoken sample of a voice, so people can hear it before
   * committing to a stream. Rendered once and cached on the Voice row —
   * re-synthesising per click would burn credits for nothing.
   */
  async preview(workspaceId: string, voiceId: string) {
    const voice = await this.get(workspaceId, voiceId);

    if (voice.previewKey) {
      return {
        url: await this.storage.signedDownloadUrl(voice.previewKey, 3600),
        cached: true,
      };
    }
    if (voice.status !== 'READY') {
      throw new BadRequestException('This voice is still processing');
    }

    const key = this.storage.buildKey(workspaceId ?? 'stock', 'audio', 'mp3');
    const sample =
      'Hey, this is how I sound on stream. Nice to meet you.';

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice.providerVoiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.config.get<string>('providers.elevenlabsKey') ?? '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: sample, model_id: 'eleven_flash_v2_5' }),
      },
    );
    if (!res.ok) {
      throw new BadRequestException(`Could not render a preview (${res.status})`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    await this.storage.upload(key, buf, 'audio/mpeg');
    await this.prisma.voice.update({
      where: { id: voice.id },
      data: { previewKey: key },
    });

    return { url: await this.storage.signedDownloadUrl(key, 3600), cached: false };
  }

  async get(workspaceId: string, voiceId: string) {
    const voice = await this.prisma.voice.findFirst({
      where: { id: voiceId, OR: [{ workspaceId: null }, { workspaceId }] },
    });
    if (!voice) throw new NotFoundException('Voice not found');
    return voice;
  }

  /** Signed URLs the client uploads raw voice samples to (mp3/wav/m4a). */
  async sampleUploadUrls(workspaceId: string, count: number) {
    if (count < 1 || count > 5) {
      throw new BadRequestException('Provide between 1 and 5 samples');
    }
    return Promise.all(
      Array.from({ length: count }, async () => {
        const key = this.storage.buildKey(workspaceId, 'audio', 'mp3');
        return {
          key,
          uploadUrl: await this.storage.signedUploadUrl(key, 'audio/mpeg'),
        };
      }),
    );
  }

  /**
   * Create a cloned voice from uploaded samples. Charges VOICE_CLONE credits;
   * refunds automatically if the provider rejects the samples.
   */
  async createClone(
    workspaceId: string,
    userId: string,
    input: { name: string; description?: string; sampleKeys: string[] },
  ) {
    if (input.sampleKeys.length < 1 || input.sampleKeys.length > 5) {
      throw new BadRequestException('Provide between 1 and 5 samples');
    }
    // Samples must belong to this workspace's storage prefix.
    for (const key of input.sampleKeys) {
      if (!key.startsWith(`${workspaceId}/`)) {
        throw new ForbiddenException('Sample does not belong to this workspace');
      }
    }

    const voice = await this.prisma.voice.create({
      data: {
        workspaceId,
        name: input.name,
        description: input.description,
        isCloned: true,
        status: 'PROCESSING',
        providerVoiceId: '',
        previewKey: input.sampleKeys[0],
        createdById: userId,
      },
    });

    await this.credits.spend(workspaceId, CREDIT_COSTS.VOICE_CLONE, 'AUDIO_GENERATION', {
      idempotencyKey: `voice-clone:${voice.id}`,
      metadata: { voiceId: voice.id },
    });

    try {
      const providerVoiceId = await this.elevenLabsClone(input.name, input.sampleKeys);
      return await this.prisma.voice.update({
        where: { id: voice.id },
        data: { providerVoiceId, status: 'READY' },
      });
    } catch (err) {
      this.logger.error(`Voice clone failed: ${(err as Error).message}`);
      await this.credits.refundJob(workspaceId, `voice-clone:${voice.id}`, CREDIT_COSTS.VOICE_CLONE);
      return this.prisma.voice.update({
        where: { id: voice.id },
        data: { status: 'FAILED' },
      });
    }
  }

  private async elevenLabsClone(name: string, sampleKeys: string[]): Promise<string> {
    const form = new FormData();
    form.append('name', name);
    for (const key of sampleKeys) {
      const url = await this.storage.signedDownloadUrl(key, 300);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not read sample ${key}`);
      const blob = new Blob([await res.arrayBuffer()], { type: 'audio/mpeg' });
      form.append('files', blob, `${key.split('/').pop()}`);
    }

    const res = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: {
        'xi-api-key': this.config.get<string>('providers.elevenlabsKey') ?? '',
      },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`ElevenLabs voice add failed (${res.status})`);
    }
    const body: any = await res.json();
    return body.voice_id as string;
  }

  async remove(workspaceId: string, voiceId: string) {
    const voice = await this.prisma.voice.findFirst({
      where: { id: voiceId, workspaceId }, // stock voices can't be deleted
    });
    if (!voice) throw new NotFoundException('Voice not found');

    if (voice.providerVoiceId) {
      // Best-effort provider cleanup; local record is the source of truth.
      await fetch(`https://api.elevenlabs.io/v1/voices/${voice.providerVoiceId}`, {
        method: 'DELETE',
        headers: {
          'xi-api-key': this.config.get<string>('providers.elevenlabsKey') ?? '',
        },
      }).catch(() => undefined);
    }
    return this.prisma.voice.delete({ where: { id: voiceId } });
  }

  /** Resolve an internal voice id to the provider voice id for TTS/real-time. */
  async resolveProviderVoice(workspaceId: string, voiceId: string) {
    const voice = await this.get(workspaceId, voiceId);
    if (voice.status !== 'READY') {
      throw new BadRequestException('This voice is still processing');
    }
    return voice;
  }

  /** Seed the shared stock voices (run once at deploy; idempotent). */
  async seedStockVoices() {
    const stock = [
      { name: 'Rachel', providerVoiceId: '21m00Tcm4TlvDq8ikWAM', description: 'Warm, conversational — tutorials and explainers' },
      { name: 'Adam', providerVoiceId: 'pNInz6obpgDQGcFmaJgB', description: 'Deep, confident — trailers and intros' },
      { name: 'Bella', providerVoiceId: 'EXAVITQu4vr4xnSDxMaL', description: 'Bright, energetic — shorts and ads' },
      { name: 'Antoni', providerVoiceId: 'ErXwobaYiN019PkySvjV', description: 'Smooth, easygoing — podcasts and streams' },
    ];
    for (const v of stock) {
      const exists = await this.prisma.voice.findFirst({
        where: { workspaceId: null, providerVoiceId: v.providerVoiceId },
      });
      if (!exists) {
        await this.prisma.voice.create({
          data: { ...v, workspaceId: null, isCloned: false, status: 'READY' },
        });
      }
    }
  }
}
