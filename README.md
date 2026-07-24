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
| `livecam/` | LiveKit token minting, 30s heartbeat metering, graceful stop when minutes run out; dispatches the GPU worker with face/voice config per session |
| `voices/` | Voice library (stock + cloned), ElevenLabs cloning with auto-refund, used by TTS and real-time voice |
| `faces/` | Face library for real-time swap; consent-gated enrollment, short-lived portrait URLs handed to the worker |
| `marketing/` | Official ad-API account linking (Meta/TikTok/Google/YouTube/LinkedIn) + campaign mirror — no engagement-panel functionality by design |

## Database setup (do this once, before first deploy)

The repo ships **no migration files** — they have to be generated against a
real database. Until you do this, your Postgres has no tables and every
request fails once it gets past auth.

Run this **from your machine**, pointed at your production database:

```bash
cd livecam-backend
npm install

# Railway: Postgres service -> Connect -> Public Network -> copy the URL.
# The ${{Postgres.DATABASE_URL}} reference is an INTERNAL hostname and will
# not resolve from your laptop.
export DATABASE_URL="postgresql://postgres:...@viaduct.proxy.rlwy.net:PORT/railway"

npx prisma migrate dev --name init
```

That creates `prisma/migrations/`, applies it, and generates the client.
**Commit the migrations folder** — it's what every future deploy replays:

```bash
git add prisma/migrations && git commit -m "initial migration" && git push
```

From then on it's automatic: `npm start` runs `prisma migrate deploy` before
booting, so the schema always matches the deployed code.

**Quicker alternative for a throwaway environment:** `npx prisma db push`
creates the tables directly from `schema.prisma` with no migration history.
Fine for experimenting, but you lose the ability to evolve the schema safely,
so prefer `migrate dev` for anything you intend to keep.

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

POST /voices                      clone a voice from samples
GET  /voices                      stock + cloned voices
POST /faces                       enroll a face (consent required)
GET  /faces                       your enrolled faces

POST /livecam/sessions            { effectPreset, voiceId?, faceId? } → token + room
POST /livecam/sessions/:id/face   swap/disable face mid-session
POST /livecam/sessions/:id/voice  swap/disable voice mid-session
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

## GPU cost control (sleep when idle)

The GPU worker is the only expensive part of the stack, so it's stopped
whenever nobody is streaming. Set these in `.env` and it manages itself:

```dotenv
RUNPOD_API_KEY=...
RUNPOD_POD_ID=...
WORKER_IDLE_SLEEP_MS=300000   # sleep 5 min after the last session ends
```

- **Wake**: the LiveCam page calls `POST /livecam/prewarm` on open, so the
  pod boots while the user picks a face. `POST /livecam/sessions` also waits
  for the worker to be healthy before handing out a token.
- **Sleep**: when the last active session ends (or runs out of minutes), a
  grace timer fires and stops the pod. The grace period prevents thrashing
  when creators overlap or restart.
- **Safety net**: the worker also watches itself — `IDLE_SHUTDOWN_SECONDS`
  (default 15 min) stops its own pod if the API's stop call never arrives, so
  an idle GPU can't bill overnight.
- Leave `RUNPOD_*` blank and the worker is treated as always-on (correct for
  self-hosted or LiveKit Cloud deployments).

Rough economics at ~$0.39/hr: an always-on pod is ~$285/month regardless of
use. With sleep enabled you pay only for streamed hours — 20 hours of real
usage is about $8.

## What's intentionally left as next steps

- **Kling adapter**: `CompositeVideoProvider` is structured for it — implement `klingGeneration()` mirroring the Luma flow once your Kling account/keys are approved, then route by cost/availability.
- **GPU inference worker** for FUA LiveCam: shipped separately as `livecam-worker` (Python + InsightFace inswapper). It joins LiveKit rooms, swaps the enrolled face frame-by-frame, and republishes the processed track. Set `LIVECAM_WORKER_URL` to point at it.
- **Desktop virtual-camera companion**: small Electron app subscribing to the processed LiveKit track and exposing it as a virtual webcam (OBS Virtual Camera SDK).
- **Ad-platform sync adapters**: OAuth flows + campaign sync for Meta Marketing API / TikTok Ads / Google Ads (each requires platform app review, so ship after you have real users).
- **VOICE_CLONE / VIDEO_EDIT** job kinds are modeled in the schema and priced; wire them to ElevenLabs voice-add and Shotstack respectively when you enable those features.
