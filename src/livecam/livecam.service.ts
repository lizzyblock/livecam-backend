import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken } from 'livekit-server-sdk';
import { customAlphabet } from 'nanoid';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { VoicesService } from '../voices/voices.service';
import { FacesService } from '../faces/faces.service';
import { WorkerControlService } from './worker-control.service';

const roomId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

/**
 * FUA LiveCam session orchestration.
 *
 * Flow:
 *  1. Client calls startSession → we check the workspace has LiveCam minutes,
 *     create a LiveKit room + short-lived access token.
 *  2. Browser publishes the webcam track to LiveKit; a GPU worker (separate
 *     deployment, e.g. Runpod) subscribes, applies the style/avatar model
 *     frame-by-frame, and republishes the processed track.
 *  3. The desktop companion app subscribes to the processed track and pipes
 *     it into a virtual webcam device for OBS/Zoom.
 *  4. A heartbeat endpoint meters seconds against the balance; endSession
 *     finalizes billing.
 */
@Injectable()
export class LivecamService {
  private readonly logger = new Logger(LivecamService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly voices: VoicesService,
    private readonly faces: FacesService,
    private readonly worker: WorkerControlService,
  ) {}

  private sleepTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Schedule the GPU pod to sleep after a grace period with no active
   * sessions. The grace period avoids thrashing when a streamer stops and
   * restarts, or when several creators overlap.
   */
  private async scheduleSleepIfIdle() {
    if (!this.worker.isManaged()) return;
    if (this.sleepTimer) clearTimeout(this.sleepTimer);

    const delay = this.config.get<number>('worker.idleSleepMs') ?? 300_000;
    this.sleepTimer = setTimeout(async () => {
      const active = await this.prisma.livecamSession.count({
        where: { status: 'ACTIVE' },
      });
      if (active === 0) {
        await this.worker.sleep();
      }
    }, delay);
  }

  /** Called when a user opens the LiveCam page, to hide the cold start. */
  async prewarm() {
    await this.worker.prewarm();
    return this.worker.status();
  }

  async workerStatus() {
    return this.worker.status();
  }

  /** Full config/reachability report — see WorkerControlService.diagnostics. */
  async workerDiagnostics() {
    return this.worker.diagnostics();
  }

  async startSession(
    workspaceId: string,
    userId: string,
    effectPreset: string,
    voiceId?: string,
    faceId?: string,
  ) {
    const balance = await this.credits.getBalance(workspaceId);
    if (balance.livecamSeconds < 60) {
      const hasPlan = await this.prisma.subscription.findFirst({
        where: { workspaceId, status: { in: ['ACTIVE', 'TRIALING'] } },
      });
      throw new BadRequestException({
        code: 'INSUFFICIENT_LIVECAM_MINUTES',
        message: hasPlan
          ? "You've used all your LiveCam minutes this cycle. They reset on " +
            'renewal, or you can top up to keep going now.'
          : 'LiveCam minutes come with a plan. Pick one to start streaming — ' +
            'every tier includes them.',
        remainingSeconds: balance.livecamSeconds,
        hasPlan: Boolean(hasPlan),
      });
    }

    // If a voice is selected, the GPU worker converts the mic track to that
    // voice in real time (speech-to-speech), alongside the video transform.
    const voice = voiceId
      ? await this.voices.resolveProviderVoice(workspaceId, voiceId)
      : null;

    // If a face is selected, the worker fetches the reference portrait once
    // (short-lived signed URL), embeds it, and swaps it frame-by-frame.
    const face = faceId
      ? await this.faces.resolveForSession(workspaceId, faceId)
      : null;

    const roomName = `livecam-${roomId()}`;
    const session = await this.prisma.livecamSession.create({
      data: {
        workspaceId,
        userId,
        roomName,
        effectPreset,
        voiceId: voice?.id,
        faceId: face?.id,
      },
    });

    const token = new AccessToken(
      this.config.get<string>('livekit.apiKey'),
      this.config.get<string>('livekit.apiSecret'),
      {
        identity: userId,
        ttl: '2h',
        // The worker reads this to configure both transforms for the room.
        metadata: JSON.stringify({
          effectPreset,
          voice: voice
            ? { provider: voice.provider, providerVoiceId: voice.providerVoiceId }
            : null,
          face: face ? { id: face.id, portraitUrl: face.portraitUrl } : null,
        }),
      },
    );
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    // Make sure the GPU pod is up before we hand the streamer a token.
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    await this.worker.ensureAwake();

    const dispatch = await this.dispatchWorker({
      room: roomName,
      effectPreset,
      voice: voice
        ? { provider: voice.provider, providerVoiceId: voice.providerVoiceId }
        : null,
      face: face ? { id: face.id, portraitUrl: face.portraitUrl } : null,
    });

    return {
      sessionId: session.id,
      roomName,
      livekitUrl: this.config.get<string>('livekit.url'),
      accessToken: await token.toJwt(),
      remainingSeconds: balance.livecamSeconds,
      voice: voice ? { id: voice.id, name: voice.name } : null,
      face: face ? { id: face.id, name: face.name } : null,
      // The session is still usable if this failed — the streamer just gets
      // an untransformed feed — but the UI needs to say so plainly.
      worker: dispatch,
    };
  }

  /**
   * Ask the GPU worker fleet to join the room and start transforming.
   * Fire-and-forget: if the worker is briefly unreachable it also watches
   * for new rooms via LiveKit webhooks as a fallback.
   */
  private async dispatchWorker(
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; detail: string }> {
    const raw = this.config.get<string>('livekit.workerUrl');
    if (!raw) {
      this.logger.warn('LIVECAM_WORKER_URL not set — no GPU worker to dispatch');
      return { ok: false, detail: 'LIVECAM_WORKER_URL is not set' };
    }
    // Same normalisation as WorkerControlService: tolerate a pasted
    // /healthz suffix or trailing slash.
    const workerUrl = raw
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/(healthz|health)$/i, '');

    const target = `${workerUrl}/dispatch`;
    this.logger.log(`Dispatching worker for room ${payload.room} -> ${target}`);

    // Awaited, not fire-and-forget. An unawaited failure here is invisible:
    // the session starts, the browser shows a passthrough, and nothing
    // anywhere says the request never landed. A few hundred milliseconds of
    // latency is worth knowing.
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      const body = await res.text().catch(() => '');
      if (!res.ok) {
        const detail = `worker returned ${res.status}: ${body.slice(0, 200)}`;
        this.logger.error(`Dispatch failed — ${detail} (${target})`);
        return { ok: false, detail };
      }

      this.logger.log(`Worker accepted room ${payload.room}: ${body.slice(0, 120)}`);
      return { ok: true, detail: body.slice(0, 120) };
    } catch (e) {
      const detail =
        (e as Error).name === 'AbortError'
          ? `no response within 10s from ${target}`
          : `${(e as Error).message} (${target})`;
      this.logger.error(`Dispatch failed — ${detail}`);
      return { ok: false, detail };
    }
  }

  /**
   * Mint a subscribe-only token for the session's room.
   *
   * This is what the desktop companion and the OBS browser source use: it can
   * watch the processed output but can't publish or control anything, so it's
   * safe to paste into a capture tool. Short TTL, tied to the live session.
   */
  async createOutputLink(workspaceId: string, sessionId: string) {
    const session = await this.prisma.livecamSession.findFirst({
      where: { id: sessionId, workspaceId, status: 'ACTIVE' },
    });
    if (!session) throw new NotFoundException('Active session not found');

    const token = new AccessToken(
      this.config.get<string>('livekit.apiKey'),
      this.config.get<string>('livekit.apiSecret'),
      { identity: `output-${sessionId}`, ttl: '6h' },
    );
    token.addGrant({
      room: session.roomName,
      roomJoin: true,
      canPublish: false,
      canPublishData: false,
      canSubscribe: true,
      hidden: true,
    });

    const url = this.config.get<string>('livekit.url');
    const jwt = await token.toJwt();

    // The companion takes a compact code; OBS takes a plain URL.
    const code = Buffer.from(JSON.stringify({ url, token: jwt })).toString('base64');

    return {
      code,
      browserSourceUrl: `${this.config.get<string>('frontendUrl')?.split(',')[0]}/output/${encodeURIComponent(code)}`,
    };
  }

  /** Switch (or disable) the swapped face mid-session. */
  async setFace(workspaceId: string, sessionId: string, faceId: string | null) {
    const session = await this.prisma.livecamSession.findFirst({
      where: { id: sessionId, workspaceId, status: 'ACTIVE' },
    });
    if (!session) throw new NotFoundException('Active session not found');

    const face = faceId
      ? await this.faces.resolveForSession(workspaceId, faceId)
      : null;

    await this.prisma.livecamSession.update({
      where: { id: sessionId },
      data: { faceId: face?.id ?? null },
    });
    // The client relays the new portraitUrl to the worker over a LiveKit
    // data message; returning it here gives the client what it needs.
    return { face };
  }

  /**
   * Switch (or disable) the real-time voice mid-session. The client relays
   * the change to the GPU worker over a LiveKit data message; this endpoint
   * validates ownership of the voice and records it for billing/history.
   */
  async setVoice(workspaceId: string, sessionId: string, voiceId: string | null) {
    const session = await this.prisma.livecamSession.findFirst({
      where: { id: sessionId, workspaceId, status: 'ACTIVE' },
    });
    if (!session) throw new NotFoundException('Active session not found');

    const voice = voiceId
      ? await this.voices.resolveProviderVoice(workspaceId, voiceId)
      : null;

    await this.prisma.livecamSession.update({
      where: { id: sessionId },
      data: { voiceId: voice?.id ?? null },
    });
    return {
      voice: voice
        ? { id: voice.id, name: voice.name, providerVoiceId: voice.providerVoiceId }
        : null,
    };
  }

  /**
   * Called by the client every 30s while streaming. Deducts metered seconds;
   * returns shouldStop=true when the balance runs dry so the client can wind
   * down gracefully instead of being cut mid-stream.
   */
  async heartbeat(workspaceId: string, sessionId: string, seconds = 30) {
    if (seconds < 1 || seconds > 120) {
      throw new BadRequestException('Heartbeat window out of range');
    }
    const session = await this.prisma.livecamSession.findFirst({
      where: { id: sessionId, workspaceId, status: 'ACTIVE' },
    });
    if (!session) throw new NotFoundException('Active session not found');

    const ok = await this.credits.consumeLivecamSeconds(workspaceId, seconds);
    if (ok) {
      await this.prisma.livecamSession.update({
        where: { id: sessionId },
        data: { billedSeconds: { increment: seconds } },
      });
    }
    const balance = await this.credits.getBalance(workspaceId);
    if (!ok) await this.scheduleSleepIfIdle();
    return { shouldStop: !ok, remainingSeconds: balance.livecamSeconds };
  }

  async endSession(workspaceId: string, userId: string, sessionId: string) {
    const session = await this.prisma.livecamSession.findFirst({
      where: { id: sessionId, workspaceId },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.userId !== userId) throw new ForbiddenException();

    const ended = await this.prisma.livecamSession.update({
      where: { id: sessionId },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    await this.scheduleSleepIfIdle();
    return ended;
  }

  async listSessions(workspaceId: string) {
    return this.prisma.livecamSession.findMany({
      where: { workspaceId },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
  }
}
