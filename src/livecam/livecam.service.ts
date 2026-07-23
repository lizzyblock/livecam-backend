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

  async startSession(
    workspaceId: string,
    userId: string,
    effectPreset: string,
    voiceId?: string,
    faceId?: string,
  ) {
    const balance = await this.credits.getBalance(workspaceId);
    if (balance.livecamSeconds < 60) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_LIVECAM_MINUTES',
        message: 'You need at least 1 minute of LiveCam time. Upgrade or top up to continue.',
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

    await this.dispatchWorker({
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
    };
  }

  /**
   * Ask the GPU worker fleet to join the room and start transforming.
   * Fire-and-forget: if the worker is briefly unreachable it also watches
   * for new rooms via LiveKit webhooks as a fallback.
   */
  private async dispatchWorker(payload: Record<string, unknown>) {
    const workerUrl = this.config.get<string>('livekit.workerUrl');
    if (!workerUrl) return;
    fetch(`${workerUrl}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((e) => this.logger.warn(`Worker dispatch failed: ${e.message}`));
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
