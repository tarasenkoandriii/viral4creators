// Публичный (НЕ /admin) контроллер постоянного Telegram-логина для
// обычного браузерного frontend/ — см. TelegramLoginService для полного
// объяснения и doc/TELEGRAM-ADMIN.md. Ни один из этих маршрутов не
// защищён гвардом: /me просто честно отвечает { loggedIn: false }, если
// cookie нет или она невалидна, — сюда же ходит анонимный пользователь,
// который никогда не логинился, и это ожидаемый, самый частый случай.

import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { OriginGuard } from '../../common/origin.guard';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { Request, Response } from 'express';
import { IsOptional } from 'class-validator';
import { TelegramLoginService } from './telegram-login.service';
import { TelegramLoginWidgetPayload } from '../admin-auth/telegram-login-widget.util';
import { parseCookieHeader, USER_SESSION_COOKIE_NAME } from './cookie.util';

// `@IsOptional()` обязательна функционально, не только для документации:
// main.ts's ValidationPipe стоит с `whitelist: true` +
// `forbidNonWhitelisted: true`, который отклоняет любое поле класса без
// хотя бы одного class-validator декоратора как "неизвестное свойство"
// (см. тот же фикс и подробное объяснение в admin-auth.controller.ts).
class DevLoginDto {
  @IsOptional()
  devUserId?: string | number;
}

// Этап 49 (В-3.2): маршруты, ставящие и снимающие cookie, проверяют
// `Origin` сами — middleware делает это только для уже разобранной cookie,
// а у нового посетителя её нет. Без гварда форма с чужого сайта сажала
// жертву в аккаунт злоумышленника (login CSRF).
@UseGuards(OriginGuard, RateLimitGuard)
@Controller('telegram-login')
export class TelegramLoginController {
  constructor(private readonly telegramLogin: TelegramLoginService) {}

  // Этап 54 (Б-3.7): подписи входа перебирают — десяти попыток в минуту с
  // одного адреса честному пользователю хватает с запасом.
  @Post('callback')
  @RateLimit({ name: 'tg-login', limit: 10, windowSec: 60 })
  async telegramCallback(
    @Body() payload: TelegramLoginWidgetPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.telegramLogin.loginWithTelegram(payload);
    this.setSessionCookie(res, result);
    return { expiresAt: result.expiresAt };
  }

  /** Docker dev-запуск — см. TelegramLoginService.devLogin(). 404, не
   * 403, вне ALLOW_DEV_AUTH/NODE_ENV!==production, тем же принципом, что
   * и у admin/auth/dev-login. */
  @Post('dev-login')
  @RateLimit({ name: 'tg-dev-login', limit: 10, windowSec: 60 })
  async devLogin(
    @Body() body: DevLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.telegramLogin.devLogin(
      String(body?.devUserId ?? '123'),
    );
    this.setSessionCookie(res, result);
    return { expiresAt: result.expiresAt };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookies = parseCookieHeader(req.headers.cookie);
    const token = cookies[USER_SESSION_COOKIE_NAME];
    if (token) {
      await this.telegramLogin.logout(token);
    }
    const isProd = process.env.NODE_ENV === 'production';
    res.clearCookie(USER_SESSION_COOKIE_NAME, {
      path: '/',
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
    });
    return { ok: true };
  }

  /** Никогда не бросает 401 — отсутствие/невалидность cookie это не
   * ошибка, а самое обычное анонимное состояние. */
  @Get('me')
  async me(@Req() req: Request) {
    const cookies = parseCookieHeader(req.headers.cookie);
    const token = cookies[USER_SESSION_COOKIE_NAME];
    if (!token) {
      return { loggedIn: false as const };
    }

    const userId = await this.telegramLogin.resolveToken(token);
    if (!userId) {
      return { loggedIn: false as const };
    }

    const me = await this.telegramLogin.me(userId);
    if (!me) {
      return { loggedIn: false as const };
    }

    return { loggedIn: true as const, ...me };
  }

  private setSessionCookie(
    res: Response,
    result: { token: string; expiresAt: Date },
  ): void {
    // Те же флаги, что у admin_session (httpOnly/secure/sameSite) — см.
    // admin-auth.controller.ts для полного обоснования каждого; frontend/
    // и backend/ так же деплоятся отдельными Vercel-доменами.
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(USER_SESSION_COOKIE_NAME, result.token, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      expires: result.expiresAt,
      path: '/',
    });
  }
}
