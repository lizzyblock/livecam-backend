import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('me')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  me(@CurrentUser() user: User) {
    return this.prisma.user.findUnique({
      where: { id: user.id },
      include: { memberships: { include: { workspace: true } } },
    });
  }

  @Get('referrals')
  async referrals(@CurrentUser() user: User) {
    const referred = await this.prisma.user.findMany({
      where: { referredById: user.id },
      select: { id: true, name: true, createdAt: true },
    });
    return { referralCode: user.referralCode, count: referred.length, referred };
  }
}
