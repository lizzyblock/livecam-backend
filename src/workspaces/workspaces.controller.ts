import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsString, MaxLength } from 'class-validator';
import { WorkspaceRole } from '@prisma/client';
import {
  AuthedMembership,
  CurrentMembership,
} from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

class RenameDto {
  @IsString()
  @MaxLength(80)
  name: string;
}

class InviteDto {
  @IsEmail()
  email: string;

  @IsEnum(WorkspaceRole)
  role: WorkspaceRole;
}

@ApiTags('workspaces')
@ApiBearerAuth()
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(m: AuthedMembership) {
    if (m.role === 'MEMBER') {
      throw new ForbiddenException('Requires admin or owner role');
    }
  }

  @Get('current')
  current(@CurrentMembership() m: AuthedMembership) {
    return this.prisma.workspace.findUnique({
      where: { id: m.workspaceId },
      include: {
        members: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } },
        subscription: true,
        creditBalance: true,
      },
    });
  }

  @Patch('current')
  rename(@CurrentMembership() m: AuthedMembership, @Body() dto: RenameDto) {
    this.assertAdmin(m);
    return this.prisma.workspace.update({
      where: { id: m.workspaceId },
      data: { name: dto.name },
    });
  }

  /** Multi-seat invite (Studio/Agency): attaches an existing user by email. */
  @Post('current/members')
  async invite(@CurrentMembership() m: AuthedMembership, @Body() dto: InviteDto) {
    this.assertAdmin(m);
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      throw new NotFoundException(
        'No LiveCam account with that email yet — ask them to sign up first.',
      );
    }
    return this.prisma.workspaceMember.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: m.workspaceId } },
      create: { userId: user.id, workspaceId: m.workspaceId, role: dto.role },
      update: { role: dto.role },
    });
  }

  @Delete('current/members/:memberId')
  async removeMember(
    @CurrentMembership() m: AuthedMembership,
    @Param('memberId') memberId: string,
  ) {
    this.assertAdmin(m);
    const target = await this.prisma.workspaceMember.findFirst({
      where: { id: memberId, workspaceId: m.workspaceId },
    });
    if (!target) throw new NotFoundException('Member not found');
    if (target.role === 'OWNER') throw new ForbiddenException('Cannot remove the owner');
    return this.prisma.workspaceMember.delete({ where: { id: memberId } });
  }
}
