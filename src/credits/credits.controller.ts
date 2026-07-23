import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CreditsService } from './credits.service';
import {
  AuthedMembership,
  CurrentMembership,
} from '../common/decorators/current-user.decorator';

@ApiTags('credits')
@ApiBearerAuth()
@Controller('credits')
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}

  @Get('balance')
  balance(@CurrentMembership() m: AuthedMembership) {
    return this.credits.getBalance(m.workspaceId);
  }

  @Get('history')
  history(
    @CurrentMembership() m: AuthedMembership,
    @Query('cursor') cursor?: string,
  ) {
    return this.credits.history(m.workspaceId, 50, cursor);
  }
}
