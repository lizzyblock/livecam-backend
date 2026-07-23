export interface GeneratedFile {
  url: string; // upstream temporary URL — we ingest into Storj immediately
  mimeType: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface ImageProvider {
  readonly name: string;
  generate(input: ImageGenerateInput): Promise<GeneratedFile[]>;
  edit(input: ImageEditInput): Promise<GeneratedFile[]>;
  upscale(imageUrl: string, scale: number): Promise<GeneratedFile[]>;
  removeBackground(imageUrl: string): Promise<GeneratedFile[]>;
}

export interface ImageGenerateInput {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  count?: number;
  quality?: 'fast' | 'high';
}

export interface ImageEditInput {
  prompt: string;
  imageUrl: string;
  maskUrl?: string;
  strength?: number;
}

export interface VideoProvider {
  readonly name: string;
  textToVideo(input: { prompt: string; durationSeconds?: number; aspectRatio?: string }): Promise<GeneratedFile[]>;
  imageToVideo(input: { imageUrl: string; prompt?: string; durationSeconds?: number }): Promise<GeneratedFile[]>;
}

export interface AudioProvider {
  readonly name: string;
  tts(input: { text: string; voiceId?: string; premium?: boolean }): Promise<GeneratedFile[]>;
  music(input: { prompt: string; durationSeconds?: number }): Promise<GeneratedFile[]>;
}
