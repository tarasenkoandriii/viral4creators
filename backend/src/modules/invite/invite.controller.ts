/**
 * Маршруты кабинета «Пригласить» — этап 133.
 *
 * `/referrals`, а не `/invite`: этап 134 добавит сюда код приглашения,
 * список приведённых и приём переходов, и звать всё это «referrals» на
 * сервере честнее, чем растягивать «invite» на то, чего экран не
 * показывает.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { loadConfiguration } from '../../config/configuration';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { TelegramIdentifiedRequest } from '../telegram-auth/telegram-identity.middleware';
import { TelegramIdentityGuard } from '../telegram-auth/telegram-identity.guard';
import { InviteService, InviteState } from './invite.service';
import { ReferralService } from './referral.service';
import { ClaimDto } from './dto/referral.dto';
import { YoutubeUnlockService } from './youtube-unlock.service';

@Controller('referrals')
@UseGuards(TelegramIdentityGuard)
export class InviteController {
  constructor(
    private readonly invite: InviteService,
    private readonly referrals: ReferralService,
    private readonly youtube: YoutubeUnlockService,
  ) {}

  /** Состояние сделки для экрана. */
  @Get('me')
  async me(@Req() req: TelegramIdentifiedRequest): Promise<InviteState> {
    return this.invite.stateOf(this.userOf(req));
  }

  /**
   * «Я подписался» — проверка подписки на Telegram-канал.
   *
   * Лимит жёсткий и намеренно: за кнопкой стоит запрос к чужому API, а
   * нажимать её человек будет ровно один раз в жизни. Двадцать нажатий
   * в минуту — это уже не человек.
   */
  @Post('telegram/check')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'unlock-telegram-check', limit: 10, windowSec: 60 })
  async checkTelegram(
    @Req() req: TelegramIdentifiedRequest,
  ): Promise<InviteState> {
    return this.invite.confirmTelegram(this.userOf(req));
  }

  /**
   * Вход через Google ради проверки подписки (этап 140) — отдаёт ссылку
   * согласия, переход делает клиент. Тот же приём, что у подключения
   * канала: identity у нас в заголовках, а не в cookie, и обычная
   * навигация браузера их не унесла бы.
   */
  @Post('youtube/start')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'unlock-youtube-start', limit: 10, windowSec: 60 })
  async startYoutube(
    @Req() req: TelegramIdentifiedRequest,
  ): Promise<{ url: string }> {
    return { url: this.youtube.authUrl(this.userOf(req)) };
  }

  /**
   * «Я подписался» — проверка подписки на наш YouTube-канал.
   *
   * Лимит тот же, что у Telegram-проверки, и по той же причине: за
   * кнопкой чужой API, а нажимают её раз в жизни.
   */
  @Post('youtube/check')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'unlock-youtube-check', limit: 10, windowSec: 60 })
  async checkYoutube(
    @Req() req: TelegramIdentifiedRequest,
  ): Promise<InviteState> {
    return this.invite.confirmYoutube(this.userOf(req));
  }

  /**
   * Привязать вошедшего к пригласившему (§5.2, этап 134).
   *
   * Зовётся клиентом СРАЗУ после первой идентификации, с кодом, который
   * он донёс из ссылки. Ответ намеренно без подробностей: «не
   * применился» может означать и чужой код, и то, что человек уже
   * привязан, и самоприглашение, — и ни об одном из этих случаев ему
   * говорить нечего, он не делал ничего плохого.
   */
  @Post('claim')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'referral-claim', limit: 10, windowSec: 60 })
  async claim(
    @Req() req: TelegramIdentifiedRequest,
    @Body() dto: ClaimDto,
  ): Promise<{ claimed: boolean }> {
    const claimed = await this.referrals.claim(this.userOf(req), dto.code);
    return { claimed };
  }

  /**
   * Гвард уже не пустил бы анонимного, но полагаться на это в коде,
   * который выдаёт генерации, не стоит: гвард могут снять правкой в
   * другом файле, а тут начисляются деньги.
   */
  private userOf(req: TelegramIdentifiedRequest): string {
    const userId = req.telegramUserId;
    if (!userId) throw new UnauthorizedException('Нужен вход через Telegram');
    return userId;
  }
}

/**
 * Публичный возврат из Google (этап 140) — вне `TelegramIdentityGuard`
 * намеренно: сюда браузер приходит по редиректу Google, наших
 * заголовков у него нет и быть не может. Кто это, известно из
 * подписанного `state`, ровно как у подключения каналов.
 *
 * Отдаёт HTML-прослойку, а не JSON: это конечная точка браузерной
 * навигации. Порядок в адресе возврата — «query перед hash»: у
 * мини-аппа маршрут живёт в хеше, и параметр после него клиент не
 * увидит.
 */
@Controller('referrals/youtube')
export class PublicYoutubeUnlockController {
  private readonly logger = new Logger(PublicYoutubeUnlockController.name);

  constructor(private readonly youtube: YoutubeUnlockService) {}

  @Get('callback')
  async callback(
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
        .send(unlockResultPage(returnUrl, false, 'Google отказал в доступе'));
      return;
    }
    try {
      await this.youtube.handleCallback(code, state);
      res
        .status(200)
        .type('html')
        .send(
          unlockResultPage(
            returnUrl,
            true,
            'Готово — вернитесь в приложение и нажмите «Проверить»',
          ),
        );
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось войти';
      this.logger.warn(`возврат из Google: ${message}`);
      res
        .status(200)
        .type('html')
        .send(unlockResultPage(returnUrl, false, message));
    }
  }
}

/** Та же прослойка, что у подключения каналов, с адресом кабинета. */
function unlockResultPage(
  returnUrl: string,
  ok: boolean,
  message: string,
): string {
  const safeMessage = message.replace(
    /[<>&]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string,
  );
  const redirectTarget = `${returnUrl}?youtube=${ok ? 'ok' : 'error'}&msg=${encodeURIComponent(message)}#/invite`;
  const safeReturnUrl = redirectTarget.replace(/"/g, '&quot;');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${ok ? 'Вход выполнен' : 'Не удалось войти'}</title>
<style>body{font-family:sans-serif;padding:32px;text-align:center;color:${ok ? '#1a7f37' : '#c1121f'}}</style>
</head><body><p>${safeMessage}</p><p><a href="${safeReturnUrl}">Вернуться в приложение</a></p>
<script>setTimeout(function(){ window.location.href = ${JSON.stringify(redirectTarget)}; }, 1500);</script>
</body></html>`;
}
