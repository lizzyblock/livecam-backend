import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeneratedFile } from './provider.interface';

/**
 * Replicate — fallback aggregator + home of cheap open-source audio models.
 * MusicGen here costs a fraction of commercial music APIs, which is the
 * right trade for background/content music.
 */
@Injectable()
export class ReplicateProvider {
  readonly name = 'replicate';
  private readonly logger = new Logger(ReplicateProvider.name);
  private readonly base = 'https://api.replicate.com/v1';

  constructor(private readonly config: ConfigService) {}

  private headers() {
    return {
      Authorization: `Bearer ${this.config.get('providers.replicateToken')}`,
      'Content-Type': 'application/json',
      Prefer: 'wait', // sync mode up to 60s — fine for music/audio
    };
  }

  async runModel(model: string, input: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.base}/models/${model}/predictions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ input }),
    });
    if (!res.ok) {
      this.logger.error(`replicate ${model} failed: ${res.status}`);
      throw new Error(`Replicate request failed (${res.status})`);
    }
    const prediction: any = await res.json();
    if (prediction.status === 'succeeded') return prediction.output;

    // Poll if not finished within sync window
    let current: any = prediction;
    for (let i = 0; i < 120 && !['succeeded', 'failed', 'canceled'].includes(current.status); i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const poll = await fetch(`${this.base}/predictions/${current.id}`, {
        headers: this.headers(),
      });
      current = await poll.json();
    }
    if (current.status !== 'succeeded') {
      throw new Error(`Replicate prediction ${current.status}`);
    }
    return current.output;
  }

  async musicGen(prompt: string, durationSeconds = 15): Promise<GeneratedFile[]> {
    const output = await this.runModel('meta/musicgen', {
      prompt,
      duration: durationSeconds,
      output_format: 'mp3',
      model_version: 'stereo-large',
    });
    const url = Array.isArray(output) ? output[0] : output;
    return [{ url, mimeType: 'audio/mpeg', durationMs: durationSeconds * 1000 }];
  }
}
