import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GeneratedFile,
  ImageEditInput,
  ImageGenerateInput,
  ImageProvider,
} from './provider.interface';

/**
 * fal.ai — primary image provider.
 * Why: FLUX schnell on fal is one of the cheapest per-image options with
 * near-instant latency, which is exactly what thumbnail/product-visual
 * workflows need. 'high' quality routes to FLUX dev.
 */
@Injectable()
export class FalImageProvider implements ImageProvider {
  readonly name = 'fal';
  private readonly logger = new Logger(FalImageProvider.name);
  private readonly base = 'https://fal.run';

  constructor(private readonly config: ConfigService) {}

  private async run(model: string, input: Record<string, unknown>) {
    const res = await fetch(`${this.base}/${model}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${this.config.get('providers.falKey')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`fal ${model} failed: ${res.status} ${body}`);
      throw new Error(`fal.ai request failed (${res.status})`);
    }
    return res.json() as Promise<any>;
  }

  private mapImages(images: any[]): GeneratedFile[] {
    return (images ?? []).map((img: any) => ({
      url: img.url,
      mimeType: img.content_type ?? 'image/png',
      width: img.width,
      height: img.height,
    }));
  }

  async generate(input: ImageGenerateInput): Promise<GeneratedFile[]> {
    const model =
      input.quality === 'high' ? 'fal-ai/flux/dev' : 'fal-ai/flux/schnell';
    const out = await this.run(model, {
      prompt: input.prompt,
      image_size: {
        width: input.width ?? 1024,
        height: input.height ?? 1024,
      },
      num_images: input.count ?? 1,
    });
    return this.mapImages(out.images);
  }

  async edit(input: ImageEditInput): Promise<GeneratedFile[]> {
    // FLUX-based inpainting/img2img
    const model = input.maskUrl
      ? 'fal-ai/flux-general/inpainting'
      : 'fal-ai/flux/dev/image-to-image';
    const out = await this.run(model, {
      prompt: input.prompt,
      image_url: input.imageUrl,
      mask_url: input.maskUrl,
      strength: input.strength ?? 0.85,
    });
    return this.mapImages(out.images);
  }

  async upscale(imageUrl: string, scale: number): Promise<GeneratedFile[]> {
    const out = await this.run('fal-ai/esrgan', {
      image_url: imageUrl,
      scale,
    });
    return this.mapImages([out.image]);
  }

  async removeBackground(imageUrl: string): Promise<GeneratedFile[]> {
    const out = await this.run('fal-ai/birefnet', { image_url: imageUrl });
    return this.mapImages([out.image]);
  }
}
