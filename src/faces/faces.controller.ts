import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength } from 'class-validator';
import { FacesService } from './faces.service';
import {
  AuthedMembership,
  CurrentMembership,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { User } from '@prisma/client';

class EnrollFaceDto {
  @IsString()
  @MaxLength(60)
  name: string;

  @IsString()
  imageKey: string;

  @IsBoolean()
  consent: boolean;
}

@ApiTags('faces')
@ApiBearerAuth()
@Controller('faces')
export class FacesController {
  constructor(private readonly faces: FacesService) {}

  @Get()
  list(@CurrentMembership() m: AuthedMembership) {
    return this.faces.list(m.workspaceId);
  }

  @Post('uploads')
  upload(@CurrentMembership() m: AuthedMembership) {
    return this.faces.portraitUploadUrl(m.workspaceId);
  }

  @Post()
  enroll(
    @CurrentMembership() m: AuthedMembership,
    @CurrentUser() user: User,
    @Body() dto: EnrollFaceDto,
  ) {
    return this.faces.enroll(m.workspaceId, user.id, dto);
  }

  @Delete(':id')
  remove(@CurrentMembership() m: AuthedMembership, @Param('id') id: string) {
    return this.faces.remove(m.workspaceId, id);
  }
}
