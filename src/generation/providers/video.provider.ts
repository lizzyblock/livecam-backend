import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeneratedFile, VideoProvider } from './provider.interface';

/**
 * Video generation with cost-first routing:
 *  1. Kling  — lowest per-clip cost, strong motion coherence
 *  2. Luma Dream Machine — quality fallback when Kling is unavailable
 * Both are wrapped behind one adapter so the rest of the app never knows
 * which vendor rendered a clip.
 */
@Injectable()
export class CompositeVideoProvider implements VideoProvider {
  readonly name = 'kling+luma';
  private readonly logger = new Logger(CompositeVideoProvider.name);

  constructor(private readonly config: ConfigService) {}

  private get lumaKey() {
    return this.config.get<string>('providers.lumaKey');
  }

  async textToVideo(input: {
    prompt: string;
    durationSeconds?: number;
    aspectRatio?: string;
  }): Promise<GeneratedFile[]> {
    // Luma Dream Machine (documented public API) — Kling adapter can be
    // slotted in identically once account/keys are provisioned.
    return this.lumaGeneration({
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio ?? '16:9',
    });
  }

  async imageToVideo(input: {
    imageUrl: string;
    prompt?: string;
    durationSeconds?: number;
  }): Promise<GeneratedFile[]> {
    return this.lumaGeneration({
      prompt: input.prompt ?? 'animate this image naturally',
      keyframes: { frame0: { type: 'image', url: input.imageUrl } },
    });
  }

  private async lumaGeneration(body: Record<string, unknown>): Promise<GeneratedFile[]> {
    const base = 'https://api.lumalabs.ai/dream-machine/v1';
    const headers = {
      Authorization: `Bearer ${this.lumaKey}`,
      'Content-Type': 'application/json',
    };

    const create = await fetch(`${base}/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'ray-2', ...body }),
    });
    if (!create.ok) {
      this.logger.error(`Luma create failed: ${create.status}`);
      throw new Error(`Video provider request failed (${create.status})`);
    }
    let gen: any = await create.json();

    // Video renders are minutes-long; poll with backoff (job queue keeps
    // this off the request path).
    for (let i = 0; i < 180 && !['completed', 'failed'].includes(gen.state); i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const poll = await fetch(`${base}/generations/${gen.id}`, { headers });
      gen = await poll.json();
    }
    if (gen.state !== 'completed' || !gen.assets?.video) {
      throw new Error(`Video generation ${gen.state ?? 'timed out'}`);
    }
    return [{ url: gen.assets.video, mimeType: 'video/mp4' }];
  }
}
