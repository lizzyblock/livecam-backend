import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { StorageService } from '../storage/storage.service';
import { FACE_ENROLL_CREDITS } from '../config/pricing';

/**
 * Face library for real-time LiveCam face swap.
 *
 * A face is enrolled from one clear reference portrait. The GPU worker
 * fetches the portrait (via a short-lived signed URL in the session
 * metadata), computes the identity embedding once, and swaps it onto the
 * streamer's face frame-by-frame.
 *
 * Consent is a hard requirement: enrollment fails without an explicit
 * attestation that the uploader owns the likeness or has permission to use
 * it, and the attestation timestamp is stored with the face.
 */
@Injectable()
export class FacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly storage: StorageService,
  ) {}

  async list(workspaceId: string) {
    return this.prisma.faceModel.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Signed URL the client uploads the reference portrait to (jpg/png). */
  async portraitUploadUrl(workspaceId: string) {
    const key = this.storage.buildKey(workspaceId, 'image', 'jpg');
    return {
      key,
      uploadUrl: await this.storage.signedUploadUrl(key, 'image/jpeg'),
    };
  }

  async enroll(
    workspaceId: string,
    userId: string,
    input: { name: string; imageKey: string; consent: boolean },
  ) {
    if (!input.consent) {
      throw new BadRequestException({
        code: 'CONSENT_REQUIRED',
        message:
          'You must confirm you own this likeness or have permission to use it.',
      });
    }
    if (!input.imageKey.startsWith(`${workspaceId}/`)) {
      throw new ForbiddenException('Portrait does not belong to this workspace');
    }

    const face = await this.prisma.faceModel.create({
      data: {
        workspaceId,
        name: input.name,
        imageKey: input.imageKey,
        consentAt: new Date(),
        createdById: userId,
      },
    });

    await this.credits.spend(workspaceId, FACE_ENROLL_CREDITS, 'LIVECAM_USAGE', {
      idempotencyKey: `face-enroll:${face.id}`,
      metadata: { faceId: face.id },
    });

    return face;
  }

  async remove(workspaceId: string, faceId: string) {
    const face = await this.prisma.faceModel.findFirst({
      where: { id: faceId, workspaceId },
    });
    if (!face) throw new NotFoundException('Face not found');
    return this.prisma.faceModel.delete({ where: { id: faceId } });
  }

  /** Resolve a face and return a short-lived portrait URL for the worker. */
  async resolveForSession(workspaceId: string, faceId: string) {
    const face = await this.prisma.faceModel.findFirst({
      where: { id: faceId, workspaceId },
    });
    if (!face) throw new NotFoundException('Face not found');
    if (face.status !== 'READY') {
      throw new BadRequestException('This face is still processing');
    }
    return {
      id: face.id,
      name: face.name,
      portraitUrl: await this.storage.signedDownloadUrl(face.imageKey, 7200),
    };
  }
}
