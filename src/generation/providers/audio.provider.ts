import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AudioProvider, GeneratedFile } from './provider.interface';
import { ReplicateProvider } from './replicate.provider';

/**
 * Audio with cost-first routing:
 *  - TTS default → ElevenLabs Flash v2.5 (half the credit cost of their
 *    flagship model, very good quality). `premium: true` upgrades to
 *    multilingual v2 for hero voiceovers.
 *  - Music → MusicGen on Replicate (open-source, pennies per track).
 */
@Injectable()
export class CompositeAudioProvider implements AudioProvider {
  readonly name = 'elevenlabs+musicgen';
  private readonly logger = new Logger(CompositeAudioProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly replicate: ReplicateProvider,
  ) {}

  async tts(input: {
    text: string;
    voiceId?: string;
    premium?: boolean;
  }): Promise<GeneratedFile[]> {
    const voice = input.voiceId ?? '21m00Tcm4TlvDq8ikWAM'; // default voice
    const model = input.premium ? 'eleven_multilingual_v2' : 'eleven_flash_v2_5';

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.config.get<string>('providers.elevenlabsKey') ?? '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: input.text, model_id: model }),
      },
    );
    if (!res.ok) {
      this.logger.error(`ElevenLabs TTS failed: ${res.status}`);
      throw new Error(`TTS request failed (${res.status})`);
    }

    // ElevenLabs streams bytes back — hand a data URL to the ingest step.
    const buf = Buffer.from(await res.arrayBuffer());
    const dataUrl = `data:audio/mpeg;base64,${buf.toString('base64')}`;
    return [{ url: dataUrl, mimeType: 'audio/mpeg' }];
  }

  async music(input: {
    prompt: string;
    durationSeconds?: number;
  }): Promise<GeneratedFile[]> {
    return this.replicate.musicGen(input.prompt, input.durationSeconds ?? 15);
  }
}
