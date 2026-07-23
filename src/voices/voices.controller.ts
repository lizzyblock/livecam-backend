import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { VoicesService } from './voices.service';
import {
  AuthedMembership,
  CurrentMembership,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { User } from '@prisma/client';

class CreateCloneDto {
  @IsString()
  @MaxLength(60)
  name: string;

  @IsString()
  @MaxLength(200)
  @IsOptional()
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  sampleKeys: string[];
}

@ApiTags('voices')
@ApiBearerAuth()
@Controller('voices')
export class VoicesController {
  constructor(private readonly voices: VoicesService) {}

  @Get()
  list(@CurrentMembership() m: AuthedMembership) {
    return this.voices.list(m.workspaceId);
  }

  @Post('uploads')
  uploads(
    @CurrentMembership() m: AuthedMembership,
    @Query('count') count?: string,
  ) {
    return this.voices.sampleUploadUrls(m.workspaceId, parseInt(count ?? '1', 10));
  }

  @Post()
  clone(
    @CurrentMembership() m: AuthedMembership,
    @CurrentUser() user: User,
    @Body() dto: CreateCloneDto,
  ) {
    return this.voices.createClone(m.workspaceId, user.id, dto);
  }

  @Delete(':id')
  remove(@CurrentMembership() m: AuthedMembership, @Param('id') id: string) {
    return this.voices.remove(m.workspaceId, id);
  }
}
