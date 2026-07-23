import { JobKind, PlanTier } from '@prisma/client';

/**
 * Credit pricing table — single source of truth for what each AI action
 * costs, tuned around cheap-but-good providers:
 *  - Images → fal.ai FLUX schnell (fast + inexpensive), Replicate fallback
 *  - Video  → Kling (lowest per-second cost), Luma as quality fallback
 *  - Voice  → PlayHT default (cheaper at scale), ElevenLabs premium flag
 *  - Music  → MusicGen via Replicate (open-source, very low cost)
 */
export const CREDIT_COSTS: Record<JobKind, number> = {
  IMAGE_GENERATE: 2,
  IMAGE_EDIT: 3,
  IMAGE_UPSCALE: 2,
  IMAGE_BG_REMOVE: 1,
  VIDEO_TEXT_TO_VIDEO: 40,
  VIDEO_IMAGE_TO_VIDEO: 40,
  VIDEO_EDIT: 15,
  TTS: 1,
  VOICE_CLONE: 25,
  MUSIC_GENERATE: 10,
};

export interface PlanDefinition {
  tier: PlanTier;
  monthlyCredits: number;
  monthlyLivecamMinutes: number;
  seats: number;
}

export const PLANS: Record<string, PlanDefinition> = {
  STARTER: { tier: 'STARTER', monthlyCredits: 500, monthlyLivecamMinutes: 60, seats: 1 },
  CREATOR: { tier: 'CREATOR', monthlyCredits: 2000, monthlyLivecamMinutes: 300, seats: 1 },
  STUDIO: { tier: 'STUDIO', monthlyCredits: 8000, monthlyLivecamMinutes: 1200, seats: 5 },
  AGENCY: { tier: 'AGENCY', monthlyCredits: 25000, monthlyLivecamMinutes: 4000, seats: 999 },
};

export const REFERRAL_BONUS_CREDITS = 100;
