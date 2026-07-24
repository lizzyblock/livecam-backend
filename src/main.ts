import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

/**
 * Fail fast with a readable message when required infrastructure is missing.
 * Without this, a missing REDIS_URL surfaces as an endless stream of
 * ECONNRESET and MaxRetriesPerRequestError with no indication of the cause.
 */
function checkRequiredEnv() {
  const required: Record<string, string> = {
    DATABASE_URL: 'Postgres connection string — on Railway use ${{Postgres.DATABASE_URL}}',
    REDIS_URL: 'Redis connection string — on Railway use ${{Redis.REDIS_URL}}',
  };

  // A very common paste error: hosted Redis is TLS-only, so redis:// gets
  // the connection reset instead of a useful error.
  const redis = process.env.REDIS_URL ?? '';
  const hostedTlsProvider = /upstash\.io|redns\.redis-cloud\.com|aivencloud\.com/.test(
    redis,
  );
  if (redis.startsWith('redis://') && hostedTlsProvider) {
    Logger.warn(
      'REDIS_URL starts with redis:// but points at a hosted provider that ' +
        'requires TLS. Change it to rediss:// or expect ECONNRESET.',
      'Bootstrap',
    );
  }

  const missing = Object.entries(required).filter(([key]) => !process.env[key]);
  if (missing.length === 0) return;

  const line = '='.repeat(64);
  Logger.error(
    [
      '',
      line,
      ' LiveCam API cannot start — missing configuration',
      line,
      '',
      ...missing.map(([key, why]) => `  ${key.padEnd(16)} ${why}`),
      '',
      ' Set these in your host\'s environment variables and redeploy.',
      line,
      '',
    ].join('\n'),
    'Bootstrap',
  );
  process.exit(1);
}

async function bootstrap() {
  checkRequiredEnv();
  const app = await NestFactory.create(AppModule, {
    // rawBody needed for Stripe webhook signature verification
    rawBody: true,
  });

  app.use(helmet());

  // Comma-separated list, e.g.
  //   FRONTEND_URL=https://yourdomain.com,https://www.yourdomain.com
  //
  // Each entry automatically also permits its www/apex counterpart, since
  // configuring only one and being hit by the other is an easy mistake that
  // produces a confusing wall of CORS rejections.
  const configured = (process.env.FRONTEND_URL ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const allowed = new Set<string>();
  for (const origin of configured) {
    allowed.add(origin);
    try {
      const url = new URL(origin);
      const host = url.host.startsWith('www.')
        ? url.host.slice(4)
        : `www.${url.host}`;
      allowed.add(`${url.protocol}//${host}`);
    } catch {
      // Not a parseable URL — keep the literal entry only.
    }
  }

  Logger.log(`CORS allows: ${[...allowed].join(', ')}`, 'Bootstrap');

  // Print the same LiveKit fingerprint the GPU worker prints. If these two
  // lines don't match, the worker's token will be rejected with a bare
  // "invalid token" 401 and nothing else will indicate why.
  {
    const { createHash } = await import('crypto');
    const secret = process.env.LIVEKIT_API_SECRET ?? '';
    const fp = secret
      ? createHash('sha256').update(secret).digest('hex').slice(0, 8)
      : 'unset';
    Logger.log(
      `LiveKit config | url=${process.env.LIVEKIT_URL ?? 'unset'} | ` +
        `key=${process.env.LIVEKIT_API_KEY ?? 'unset'} | secret_fp=${fp}`,
      'Bootstrap',
    );
    if (secret !== secret.trim() || (process.env.LIVEKIT_API_KEY ?? '') !== (process.env.LIVEKIT_API_KEY ?? '').trim()) {
      Logger.warn(
        'LiveKit credentials contain leading/trailing whitespace — this ' +
          'produces invalid tokens. Re-paste them.',
        'Bootstrap',
      );
    }
  }

  const rejected = new Set<string>();

  app.enableCors({
    origin: (origin, cb) => {
      // Same-origin and server-to-server calls send no Origin header.
      if (!origin) return cb(null, true);
      const clean = origin.replace(/\/$/, '');
      if (allowed.has(clean)) return cb(null, true);

      const preview = process.env.FRONTEND_PREVIEW_SUFFIX;
      if (preview && clean.endsWith(preview)) return cb(null, true);

      // Log each bad origin once. The frontend polls, so throwing (and
      // logging a stack trace) per request buries every other log line.
      if (!rejected.has(clean)) {
        rejected.add(clean);
        Logger.warn(
          `CORS rejected origin ${clean} — add it to FRONTEND_URL ` +
            `(currently: ${[...allowed].join(', ')})`,
          'Bootstrap',
        );
      }
      cb(null, false); // respond without CORS headers instead of throwing
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Workspace-Id'],
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  const swagger = new DocumentBuilder()
    .setTitle('LiveCam API')
    .setDescription('AI content platform for creators, streamers, and marketing teams')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));

  const port = parseInt(process.env.PORT ?? '4000', 10);
  await app.listen(port);
  Logger.log(`LiveCam API running on :${port} — docs at /docs`, 'Bootstrap');
}

bootstrap();
