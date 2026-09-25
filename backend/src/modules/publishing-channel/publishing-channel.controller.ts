/**
 * User side (TelegramIdentityGuard — a channel needs an owner):
 *   POST   /channels/oauth/:platform/start   → { url } — window.location.href = url
 *   GET    /channels                          this user's connected channels
 *   DELETE /channels/:id                      disconnect
 *
 * Public (Google/TikTok redirect here directly — no headers of ours):
 *   GET /channels/oauth/:platform/callback?code=&state=
 */

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { PublishingChannelService } from './publishing-channel.service';
import { PublishingChannelView } from '../../common/types/publishing-channel.types';
import { loadConfiguration } from '../../config/configuration';

@Controller('channels')
@UseGuards(TelegramIdentityGuard)
export class PublishingChannelController {
  constructor(private readonly service: PublishingChannelService) {}

  /**
   * `?extended=1` (этап 137) — расширенное согласие ради субтитров.
   * Query, а не отдельный маршрут: это тот же старт того же OAuth, с
   * одним дополнительным правом в ссылке.
   */
  @Post('oauth/:platform/start')
  async start(
    @Req() req: IdentifiedRequest,
    @Param('platform') platform: string,
    @Query('extended') extended?: string,
  ): Promise<{ url: string }> {
    return {
      url: await this.service.buildAuthUrl(
        req.telegramUserId,
        platform,
        extended === '1' || extended === 'true',
      ),
    };
  }

  @Get()
  list(@Req() req: IdentifiedRequest): Promise<PublishingChannelView[]> {
    return this.service.listForUser(req.telegramUserId);
  }

  @Delete(':id')
  @HttpCode(204)
  disconnect(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ): Promise<void> {
    return this.service.disconnect(req.telegramUserId, id);
  }
}

/**
 * Публичный callback — вне TelegramIdentityGuard намеренно (см. шапку
 * файла). Отдаёт не JSON, а маленькую HTML-страницу с редиректом обратно
 * в TMA/лендинг: это конечная точка браузерной навигации, а не axios-вызов.
 */
@Controller('channels/oauth')
export class PublicPublishingChannelController {
  constructor(private readonly service: PublishingChannelService) {}

  @Get(':platform/callback')
  async callback(
    @Param('platform') platform: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const returnUrl = loadConfiguration().publishing.tmaUrl || '/';
    if (error) {
      res
        .status(200)
        .type('html')
        .send(resultPage(returnUrl, false, `Площадка отказала: ${error}`));
      return;
    }
    try {
      const channel = await this.service.handleCallback(platform, code, state);
      res
        .status(200)
        .type('html')
        .send(
          resultPage(returnUrl, true, `Канал «${channel.title}» подключён.`),
        );
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'Не удалось подключить канал';
      res
        .status(200)
        .type('html')
        .send(resultPage(returnUrl, false, message));
    }
  }
}

/**
 * Г-1.4 (аудит round4, этап 64): раньше редирект вёл на голый `tmaUrl`
 * (корень) — пустой хеш рендерит «Проекты» (см. Г-1.1/App.tsx), и
 * человек приземлялся там, а не на «Каналы», без единого слова об
 * итоге (страница-прослойка живёт 1,5 с и сама никуда не встроена).
 * Теперь ведём прямо на `#/channels` с результатом в РЕАЛЬНОМ
 * query (`?oauth=ok|error&msg=...`) — ПЕРЕД хешем, а не внутри него:
 * `router.ts:parseRoute` не умеет отделять query-часть от пути внутри
 * хеша (та же причина, что в App.tsx у Г-1.1), а `window.location.search`
 * не зависит от хеша, так что порядок `?...#/channels` даёт рабочими
 * СРАЗУ оба — и разбор результата на экране, и сам переход на «Каналы».
 */
function resultPage(returnUrl: string, ok: boolean, message: string): string {
  const safeMessage = message.replace(
    /[<>&]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string,
  );
  const redirectTarget = `${returnUrl}?oauth=${ok ? 'ok' : 'error'}&msg=${encodeURIComponent(message)}#/channels`;
  const safeReturnUrl = redirectTarget.replace(/"/g, '&quot;');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${ok ? 'Канал подключён' : 'Не удалось подключить канал'}</title>
<style>body{font-family:sans-serif;padding:32px;text-align:center;color:${ok ? '#1a7f37' : '#c1121f'}}</style>
</head><body><p>${safeMessage}</p><p><a href="${safeReturnUrl}">Вернуться в приложение</a></p>
<script>setTimeout(function(){ window.location.href = ${JSON.stringify(redirectTarget)}; }, 1500);</script>
</body></html>`;
}
