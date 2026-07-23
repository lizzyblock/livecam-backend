import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { AdPlatform } from '@prisma/client';
import { MarketingService } from './marketing.service';
import {
  AuthedMembership,
  CurrentMembership,
} from '../common/decorators/current-user.decorator';

class ConnectAccountDto {
  @IsEnum(AdPlatform)
  platform: AdPlatform;

  @IsString()
  externalId: string;

  @IsString()
  @IsOptional()
  displayName?: string;

  @IsString()
  accessToken: string;

  @IsString()
  @IsOptional()
  refreshToken?: string;

  @IsDateString()
  @IsOptional()
  expiresAt?: string;
}

@ApiTags('marketing')
@ApiBearerAuth()
@Controller('marketing')
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @Post('accounts')
  connect(@CurrentMembership() m: AuthedMembership, @Body() dto: ConnectAccountDto) {
    return this.marketing.connectAccount(m.workspaceId, {
      ...dto,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    });
  }

  @Get('accounts')
  accounts(@CurrentMembership() m: AuthedMembership) {
    return this.marketing.listAccounts(m.workspaceId);
  }

  @Get('accounts/:id/campaigns')
  campaigns(@CurrentMembership() m: AuthedMembership, @Param('id') id: string) {
    return this.marketing.listCampaigns(m.workspaceId, id);
  }
}
