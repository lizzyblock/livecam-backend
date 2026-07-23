import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { LivecamService } from './livecam.service';
import {
  AuthedMembership,
  CurrentMembership,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { User } from '@prisma/client';

class StartSessionDto {
  @IsString()
  effectPreset: string;

  @IsString()
  @IsOptional()
  voiceId?: string;

  @IsString()
  @IsOptional()
  faceId?: string;
}

class SetFaceDto {
  @IsString()
  @IsOptional()
  faceId?: string | null;
}

class SetVoiceDto {
  @IsString()
  @IsOptional()
  voiceId?: string | null;
}

class HeartbeatDto {
  @IsInt()
  @Min(1)
  @Max(120)
  @IsOptional()
  seconds?: number;
}

@ApiTags('livecam')
@ApiBearerAuth()
@Controller('livecam')
export class LivecamController {
  constructor(private readonly livecam: LivecamService) {}

  @Post('sessions')
  start(
    @CurrentMembership() m: AuthedMembership,
    @CurrentUser() user: User,
    @Body() dto: StartSessionDto,
  ) {
    return this.livecam.startSession(m.workspaceId, user.id, dto.effectPreset, dto.voiceId, dto.faceId);
  }

  /** Token + URL for the desktop companion and OBS browser source. */
  @Post('sessions/:id/output-link')
  outputLink(
    @CurrentMembership() m: AuthedMembership,
    @Param('id') id: string,
  ) {
    return this.livecam.createOutputLink(m.workspaceId, id);
  }

  @Post('sessions/:id/face')
  setFace(
    @CurrentMembership() m: AuthedMembership,
    @Param('id') id: string,
    @Body() dto: SetFaceDto,
  ) {
    return this.livecam.setFace(m.workspaceId, id, dto.faceId ?? null);
  }

  @Post('sessions/:id/voice')
  setVoice(
    @CurrentMembership() m: AuthedMembership,
    @Param('id') id: string,
    @Body() dto: SetVoiceDto,
  ) {
    return this.livecam.setVoice(m.workspaceId, id, dto.voiceId ?? null);
  }

  @Post('sessions/:id/heartbeat')
  heartbeat(
    @CurrentMembership() m: AuthedMembership,
    @Param('id') id: string,
    @Body() dto: HeartbeatDto,
  ) {
    return this.livecam.heartbeat(m.workspaceId, id, dto.seconds ?? 30);
  }

  @Post('sessions/:id/end')
  end(
    @CurrentMembership() m: AuthedMembership,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    return this.livecam.endSession(m.workspaceId, user.id, id);
  }

  /** Called when the LiveCam page opens — boots the GPU pod early. */
  @Post('prewarm')
  prewarm() {
    return this.livecam.prewarm();
  }

  @Get('worker')
  workerStatus() {
    return this.livecam.workerStatus();
  }

  @Get('sessions')
  list(@CurrentMembership() m: AuthedMembership) {
    return this.livecam.listSessions(m.workspaceId);
  }
}
