import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  type MiddlewareConsumer,
  NotFoundException,
  RequestMethod,
} from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import {
  loadStoryAccess,
  storyCanBuild,
  storyCanRead,
  storyNeedsTerms,
  storyTalesMode,
  type StoryAccessFacts,
} from './story-access';

export type StoryAccessRequest = {
  telegramUserId?: string;
  method?: string;
  storyAccess?: StoryAccessFacts;
};

/**
 * Р-ST3-1: Story-Tales routes of a user (replaces the owner-only development
 * guard). Mode from `STORY_TALES_ACCESS` (`owner` by default). Reading and
 * deleting (GET/HEAD/DELETE) is allowed to whoever may hold own data, a
 * mutation (POST) needs full access; when only the Story rules are missing
 * the answer is 403 `STORY_TERMS_REQUIRED`, otherwise 404 as before.
 */
@Injectable()
export class StoryAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<StoryAccessRequest>();
    const userId = req.telegramUserId;
    if (!userId) throw new NotFoundException();
    const facts = await loadStoryAccess(this.prisma, userId);
    req.storyAccess = facts;
    const method = (req.method ?? 'GET').toUpperCase();
    if (['GET', 'HEAD', 'DELETE'].includes(method)) {
      if (storyCanRead(facts)) return true;
      throw new NotFoundException();
    }
    if (storyCanBuild(facts)) return true;
    if (storyNeedsTerms(facts))
      throw new ForbiddenException({
        code: 'STORY_TERMS_REQUIRED',
        message:
          'Подтвердите, что вам 18+, и примите правила Story-Tales перед созданием подарка',
      });
    throw new NotFoundException();
  }
}

/** Headers of every public gift answer, including 404 (ТЗ §11.2). */
export const STORY_PUBLIC_HEADERS: Readonly<Record<string, string>> = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

/**
 * Р-ST3-3: public gift links work only in `pilot`/`public`; in `owner` mode
 * every link (including old media URLs) is 404 as before. The noindex and
 * no-referrer headers are set before any decision, so a 404 carries them too.
 */
@Injectable()
export class StoryPublicAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getResponse<Response>().set(STORY_PUBLIC_HEADERS);
    if (storyTalesMode() === 'owner') throw new NotFoundException();
    return true;
  }
}

/**
 * Р-ST3-BE-18 (ST3-U-07): Gemini features without credit pricing — the
 * reference analysis library and narrator looks — stay owner-only in
 * `pilot`/`public` until they are priced. Runs after StoryAccessGuard (its
 * facts on the request); a participant gets 403 `STORY_FEATURE_OWNER_ONLY`.
 */
@Injectable()
export class StoryOwnerOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const facts = context
      .switchToHttp()
      .getRequest<StoryAccessRequest>().storyAccess;
    if (!facts) throw new NotFoundException();
    if (facts.isOwner) return true;
    throw new ForbiddenException({
      code: 'STORY_FEATURE_OWNER_ONLY',
      message:
        'Эта функция пока доступна только владельцу Story-Tales: она ещё не тарифицируется кредитами',
    });
  }
}

/**
 * ST3-S-06 (ТЗ §11.2): every answer under `/story-gift/*` — unknown
 * sub-paths, other methods, router 404s — carries noindex and no-referrer.
 */
export function storyPublicHeadersMiddleware(
  _req: unknown,
  res: Response,
  next: () => void,
) {
  res.set(STORY_PUBLIC_HEADERS);
  next();
}
export function applyStoryPublicHeaders(consumer: MiddlewareConsumer) {
  consumer
    .apply(storyPublicHeadersMiddleware)
    .forRoutes(
      { path: 'story-gift', method: RequestMethod.ALL },
      { path: 'story-gift/{*rest}', method: RequestMethod.ALL },
    );
}
