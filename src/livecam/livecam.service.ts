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
  ) {}

  async startSession(workspaceId: string, userId: string, effectPreset: string) {
    const balance = await this.credits.getBalance(workspaceId);
    if (balance.livecamSeconds < 60) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_LIVECAM_MINUTES',
        message: 'You need at least 1 minute of LiveCam time. Upgrade or top up to continue.',
      });
    }

    const roomName = `livecam-${roomId()}`;
    const session = await this.prisma.livecamSession.create({
      data: { workspaceId, userId, roomName, effectPreset },
    });

    const token = new AccessToken(
      this.config.get<string>('livekit.apiKey'),
      this.config.get<string>('livekit.apiSecret'),
      { identity: userId, ttl: '2h' },
    );
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    return {
      sessionId: session.id,
      roomName,
      livekitUrl: this.config.get<string>('livekit.url'),
      accessToken: await token.toJwt(),
      remainingSeconds: balance.livecamSeconds,
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
    return { shouldStop: !ok, remainingSeconds: balance.livecamSeconds };
  }

  async endSession(workspaceId: string, userId: string, sessionId: string) {
    const session = await this.prisma.livecamSession.findFirst({
      where: { id: sessionId, workspaceId },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.userId !== userId) throw new ForbiddenException();

    return this.prisma.livecamSession.update({
      where: { id: sessionId },
      data: { status: 'ENDED', endedAt: new Date() },
    });
  }

  async listSessions(workspaceId: string) {
    return this.prisma.livecamSession.findMany({
      where: { workspaceId },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
  }
}
