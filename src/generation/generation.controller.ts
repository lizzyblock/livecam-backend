import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GenerationService } from './generation.service';
import { CreateGenerationJobDto } from './dto/create-job.dto';
import {
  AuthedMembership,
  CurrentMembership,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { User } from '@prisma/client';

@ApiTags('generation')
@ApiBearerAuth()
@Controller('generation')
export class GenerationController {
  constructor(private readonly generation: GenerationService) {}

  @Post('jobs')
  create(
    @CurrentMembership() m: AuthedMembership,
    @CurrentUser() user: User,
    @Body() dto: CreateGenerationJobDto,
  ) {
    return this.generation.createJob(m.workspaceId, user.id, dto);
  }

  @Get('jobs')
  list(@CurrentMembership() m: AuthedMembership, @Query('cursor') cursor?: string) {
    return this.generation.listJobs(m.workspaceId, 30, cursor);
  }

  @Get('jobs/:id')
  get(@CurrentMembership() m: AuthedMembership, @Param('id') id: string) {
    return this.generation.getJob(m.workspaceId, id);
  }

  @Get('assets')
  assets(
    @CurrentMembership() m: AuthedMembership,
    @Query('type') type?: 'IMAGE' | 'VIDEO' | 'AUDIO',
  ) {
    return this.generation.listAssets(m.workspaceId, type);
  }
}
