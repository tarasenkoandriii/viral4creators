import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  PostprodVideosService,
  PostprodVideoListResult,
} from './postprod-videos.service';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';

/**
 * PostprodVideosController — список готовых роликов пользователя для
 * вкладки «Постпрод» в TMA (этап 88). В отличие от
 * `PostProdController` (`sessions/:sessionId/postprod/...`, действует
 * на ОДНУ уже открытую сессию), это collection-level маршрут — «все мои
 * ролики» — поэтому нужна настоящая личность (`TelegramIdentityGuard`,
 * тот же приём, что `ProjectController`: список, на который пользователь
 * возвращается позже, не может быть анонимным — без владельца нечего
 * листать).
 */
@Controller('postprod/videos')
@UseGuards(TelegramIdentityGuard)
export class PostprodVideosController {
  constructor(private readonly videos: PostprodVideosService) {}

  @Get()
  list(
    @Req() req: IdentifiedRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<PostprodVideoListResult> {
    return this.videos.listFinishedVideos(
      req.telegramUserId,
      Math.max(parseInt(page ?? '1', 10) || 1, 1),
      Math.min(Math.max(parseInt(pageSize ?? '20', 10) || 20, 1), 100),
    );
  }
}
