export default () => ({
  port: parseInt(process.env.PORT ?? '4000', 10),
  environment: process.env.NODE_ENV ?? 'development',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',

  database: { url: process.env.DATABASE_URL },
  // No localhost fallback in production: silently pointing at a Redis that
  // isn't there produces an infinite ioredis retry loop rather than an error.
  redis: {
    url:
      process.env.REDIS_URL ??
      (process.env.NODE_ENV === 'production'
        ? undefined
        : 'redis://localhost:6379'),
  },

  clerk: {
    issuer: process.env.CLERK_ISSUER,
    jwksUrl: process.env.CLERK_JWKS_URL,
    webhookSecret: process.env.CLERK_WEBHOOK_SECRET,
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    prices: {
      starter: process.env.STRIPE_PRICE_STARTER,
      creator: process.env.STRIPE_PRICE_CREATOR,
      studio: process.env.STRIPE_PRICE_STUDIO,
      topup1000: process.env.STRIPE_PRICE_TOPUP_1000,
    },
  },

  storage: {
    endpoint: process.env.STORJ_ENDPOINT ?? 'https://gateway.storjshare.io',
    accessKeyId: process.env.STORJ_ACCESS_KEY,
    secretAccessKey: process.env.STORJ_SECRET_KEY,
    bucket: process.env.STORJ_BUCKET ?? 'livecam-assets',
  },

  livekit: {
    url: process.env.LIVEKIT_URL,
    apiKey: process.env.LIVEKIT_API_KEY,
    apiSecret: process.env.LIVEKIT_API_SECRET,
    workerUrl: process.env.LIVECAM_WORKER_URL, // GPU worker dispatch endpoint
  },

  worker: {
    // Optional — when set, the GPU pod is stopped while LiveCam is idle
    // and started on demand. Leave unset for an always-on worker.
    runpodApiKey: process.env.RUNPOD_API_KEY,
    runpodPodId: process.env.RUNPOD_POD_ID,
    bootTimeoutMs: parseInt(process.env.WORKER_BOOT_TIMEOUT_MS ?? '120000', 10),
    idleSleepMs: parseInt(process.env.WORKER_IDLE_SLEEP_MS ?? '300000', 10),
  },

  providers: {
    falKey: process.env.FAL_KEY,
    replicateToken: process.env.REPLICATE_API_TOKEN,
    lumaKey: process.env.LUMA_API_KEY,
    klingKey: process.env.KLING_API_KEY,
    elevenlabsKey: process.env.ELEVENLABS_API_KEY,
    playhtKey: process.env.PLAYHT_API_KEY,
    playhtUserId: process.env.PLAYHT_USER_ID,
  },
});
