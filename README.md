# LiveCam — Backend (NestJS)

Subscription SaaS backend for AI-assisted content creation: prompt-based image editing, AI video, voice/music tools, real-time webcam transformation (FUA LiveCam), and ad-campaign management for creators and marketing teams.

## Architecture at a glance

```
                        ┌────────────────────────────┐
  Next.js frontend ───► │  NestJS API  (/api/v1)     │
                        │  Clerk JWT guard (global)  │
                        └──────┬─────────────┬───────┘
                               │             │
                    ┌──────────▼───┐   ┌─────▼──────────┐
                    │ PostgreSQL   │   │ Redis / BullMQ │
                    │ (Prisma)     │   │ generation q   │
                    └──────────────┘   └─────┬──────────┘
                                             │ worker (in-process, concurrency 8)
                          ┌──────────────────┼──────────────────┐
                          ▼                  ▼                  ▼
                     fal.ai (FLUX)      Luma / Kling       ElevenLabs Flash
                     images, cheap      video gen          + MusicGen (Replicate)
                          └────────────── outputs ────────────────┘
                                             │
                                       Storj (S3-compat)
                                       storage + delivery
```

Real-time FUA LiveCam runs on **LiveKit**: this API mints room tokens and meters minutes; a separate GPU worker deployment (Runpod/Modal) joins the room, transforms frames, and republishes the processed track.

## Cost-first provider choices

| Need | Pick | Why it's the best quality-per-dollar |
|---|---|---|
| Image gen/edit | **fal.ai FLUX schnell** (dev for "high") | Near-instant, among the cheapest per image; inpainting, upscale (ESRGAN), BG removal (BiRefNet) on the same key |
| Video | **Luma Ray-2** now, **Kling** adapter slot | Both far cheaper than Runway per clip; wrapped in one adapter so you can switch by env var |
| TTS | **ElevenLabs Flash v2.5** default | Half the credit cost of their flagship; `premium: true` upgrades per-request |
| Music | **MusicGen via Replicate** | Open-source — pennies per track vs. commercial music APIs |
| Storage + CDN | **Storj** | ~$0.004/GB and free egress up to 3× stored data; serves files directly, so no separate CDN bill |
| Real-time | **LiveKit self-hosted** | Open-source WebRTC SFU; no per-minute vendor fees, you only pay for your own compute |

Every provider sits behind an adapter (`src/generation/providers/`) so swapping vendors never touches controllers or the frontend.

## Modules

| Path | What it owns |
|---|---|
| `auth/` | Clerk webhook (Svix-verified) → provisions User + personal Workspace + trial credits; referral bonus payout |
| `users/`, `workspaces/` | Profile, referral stats, multi-seat team management (invite/remove, roles) |
| `credits/` | Immutable double-entry ledger + cached balance; atomic spend/grant with idempotency keys; auto-refund on failed jobs |
| `billing/` | Stripe Checkout (subscriptions + credit top-ups), Customer Portal, webhook sync, monthly credit + LiveCam-minute grants on `invoice.paid` |
| `generation/` | Job creation (credits reserved up-front), job/asset listing with signed download URLs |
| `jobs/` | BullMQ worker: routes to provider, ingests output into Storj, records assets, refunds credits on terminal failure |
| `livecam/` | LiveKit token minting, 30s heartbeat metering, graceful stop when minutes run out |
| `marketing/` | Official ad-API account linking (Meta/TikTok/Google/YouTube/LinkedIn) + campaign mirror — no engagement-panel functionality by design |

## Getting started

```bash
cp .env.example .env          # fill in keys
docker compose up -d          # Postgres + Redis
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run start:dev             # API on :4000, Swagger at /docs
```

## Key API surface (all under `/api/v1`, Bearer auth, `X-Workspace-Id` header optional)

```
GET  /me                          profile + workspaces
GET  /me/referrals                referral code + signups
GET  /workspaces/current          workspace, members, plan, balance
POST /workspaces/current/members  invite teammate (Studio/Agency seats)

GET  /credits/balance             credits + livecam seconds
GET  /credits/history             ledger (cursor-paginated)

POST /billing/checkout/subscription   { priceId } → Stripe Checkout URL
POST /billing/checkout/topup          { credits } → one-off top-up
POST /billing/portal                  Customer Portal URL
POST /billing/webhooks/stripe         (public, signature-verified)

POST /generation/jobs             { kind, prompt, ... } → queued job
GET  /generation/jobs/:id         status + signed asset URLs
GET  /generation/assets?type=IMAGE

POST /livecam/sessions            { effectPreset } → LiveKit token + room
POST /livecam/sessions/:id/heartbeat   meters 30s; shouldStop when dry
POST /livecam/sessions/:id/end

POST /auth/webhooks/clerk         (public, Svix-verified)
GET  /health                      (public)
```

## Billing model implemented

- Subscription tiers (Starter/Creator/Studio/Agency) defined in `src/config/pricing.ts` — the single source of truth for credit allotments, LiveCam minutes, seats, and per-action credit costs.
- `invoice.paid` webhook grants the month's credits and LiveCam seconds idempotently (keyed by invoice ID), so retries never double-grant.
- Credit spends are reserved when a job is created and **automatically refunded** if the provider fails after retries — users never pay for failed generations.
- One-off top-ups via Stripe Checkout `mode: payment` with per-credit pricing you can tune in `billing.service.ts`.

## What's intentionally left as next steps

- **Kling adapter**: `CompositeVideoProvider` is structured for it — implement `klingGeneration()` mirroring the Luma flow once your Kling account/keys are approved, then route by cost/availability.
- **GPU inference worker** for FUA LiveCam: a separate Python service that joins LiveKit rooms and runs LivePortrait/StreamDiffusion-style models — deploy on Runpod with autoscaling by active session count.
- **Desktop virtual-camera companion**: small Electron app subscribing to the processed LiveKit track and exposing it as a virtual webcam (OBS Virtual Camera SDK).
- **Ad-platform sync adapters**: OAuth flows + campaign sync for Meta Marketing API / TikTok Ads / Google Ads (each requires platform app review, so ship after you have real users).
- **VOICE_CLONE / VIDEO_EDIT** job kinds are modeled in the schema and priced; wire them to ElevenLabs voice-add and Shotstack respectively when you enable those features.
