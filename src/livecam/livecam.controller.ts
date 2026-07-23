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
    return this.livecam.startSession(m.workspaceId, user.id, dto.effectPreset);
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

  @Get('sessions')
  list(@CurrentMembership() m: AuthedMembership) {
    return this.livecam.listSessions(m.workspaceId);
  }
}
