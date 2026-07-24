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

  // Comma-separated list so you can allow your apex domain, www, and any
  // Vercel preview URLs at once. e.g.
  //   FRONTEND_URL=https://yourdomain.com,https://www.yourdomain.com
  const origins = (process.env.FRONTEND_URL ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, cb) => {
      // Allow same-origin/server-side calls with no Origin header.
      if (!origin) return cb(null, true);
      if (origins.includes(origin)) return cb(null, true);
      // Allow Vercel preview deployments if a preview suffix is configured.
      const preview = process.env.FRONTEND_PREVIEW_SUFFIX;
      if (preview && origin.endsWith(preview)) return cb(null, true);
      cb(new Error(`Origin not allowed by CORS: ${origin}`));
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
