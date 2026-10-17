import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Development is private by default. Identity comes from validated middleware,
 * never a caller-supplied Telegram ID. Roles and paid plans confer no access. */
@Injectable()
export class StoryDevelopmentGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const userId = context
      .switchToHttp()
      .getRequest<{ telegramUserId?: string }>().telegramUserId;
    const telegramId = process.env.STORY_TALES_OWNER_TELEGRAM_ID?.trim();
    if (!userId || !telegramId) throw new NotFoundException();
    const owner = await this.prisma.user.findFirst({
      where: { id: userId, telegramId },
      select: { id: true },
    });
    if (!owner) throw new NotFoundException();
    return true;
  }
}

/** Gift links, including links created before development lockdown, stay closed.
 * Provider render-input receipts are separate, short-lived capabilities. */
@Injectable()
export class StoryPublicDisabledGuard implements CanActivate {
  canActivate(): never {
    throw new NotFoundException();
  }
}
