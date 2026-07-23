import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User, WorkspaceMember, Workspace } from '@prisma/client';

export type AuthedMembership = WorkspaceMember & { workspace: Workspace };

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): User =>
    ctx.switchToHttp().getRequest().user,
);

export const CurrentMembership = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthedMembership =>
    ctx.switchToHttp().getRequest().membership,
);
