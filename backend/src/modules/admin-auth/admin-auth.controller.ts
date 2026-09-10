// Контроллер поверх AdminAuthService. Перенесено из Devil's Advocate
// (apps/api/src/admin-auth/admin-auth.controller.ts) — ResponseInterceptor
// здесь не навешивается локально (в отличие от DA), потому что в этом
// проекте он уже глобальный (see main.ts's app.useGlobalInterceptors).

import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { IsOptional } from 'class-validator';
import {
  AdminSessionGuard,
  AdminAuthenticatedRequest,
} from './admin-session.guard';
import { AdminAuthService } from './admin-auth.service';
import { OriginGuard } from '../../common/origin.guard';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { TelegramLoginWidgetPayload } from './telegram-login-widget.util';
import { ADMIN_SESSION_COOKIE_NAME, parseCookieHeader } from './cookie.util';

/** Docker dev-запуск: тело POST /admin/auth/dev-login. devUserId
 * необязателен — без него берётся "123", тот же дефолт, что у
 * VITE_DEV_USER_ID/DEV_USER_ID, чтобы TMA и админка из коробки
 * открывались под одним пользователем.
 *
 * `@IsOptional()` не просто документирует необязательность — она
 * обязательна и функционально: main.ts's ValidationPipe стоит с
 * `whitelist: true` + `forbidNonWhitelisted: true`, а тот отбрасывает
 * (и с forbidNonWhitelisted — вовсе отклоняет запрос) любое поле класса
 * без хотя бы одного class-validator декоратора, считая его "неизвестным
 * свойством" — именно так админка и падала на dev-login с `property
 * devUserId should not exist`, хотя поле было объявлено в классе. */
class DevLoginDto {
  @IsOptional()
  devUserId?: string | number;
}

// Этап 49 (В-3.2, В-3.6): см. OriginGuard — вход и выход админки без
// проверки `Origin` позволяли посадить жертву в чужую admin-сессию и
// выкинуть оператора с чужого сайта.
@UseGuards(OriginGuard, RateLimitGuard)
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  // Этап 54 (Б-3.7): вход в админку — самая ценная дверь, лимит на адрес.
  @Post('telegram-callback')
  @RateLimit({ name: 'admin-login', limit: 10, windowSec: 60 })
  async telegramCallback(
    @Body() payload: TelegramLoginWidgetPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.adminAuth.loginWithTelegram(payload);
    this.setSessionCookie(res, result);
    // Токен — только в httpOnly cookie, не в теле ответа: иначе он был
    // бы доступен JS на домене админки (обесценивает httpOnly, ради
    // которого cookie и заведена). Клиенту нужен только срок действия.
    return { expiresAt: result.expiresAt };
  }

  /**
   * Docker dev-запуск — вход в админку без Telegram Login Widget.
   * Доступен ТОЛЬКО при ALLOW_DEV_AUTH=true и NODE_ENV!==production;
   * сама проверка живёт в AdminAuthService.devLogin(). Вне dev отвечает
   * 404 — как несуществующий маршрут, не 403.
   */
  @Post('dev-login')
  @RateLimit({ name: 'admin-dev-login', limit: 10, windowSec: 60 })
  async devLogin(
    @Body() body: DevLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.adminAuth.devLogin(
      String(body?.devUserId ?? '123'),
    );
    this.setSessionCookie(res, result);
    return { expiresAt: result.expiresAt };
  }

  private setSessionCookie(
    res: Response,
    result: { token: string; expiresAt: Date },
  ): void {
    // httpOnly — недоступна из JS клиента (защита от XSS-кражи токена);
    // secure — только по HTTPS в проде, dev допускает http локально;
    // sameSite=none в проде — admin/ и backend/ деплоятся как ОТДЕЛЬНЫЕ
    // Vercel-домены, а fetch(credentials:'include') с одного домена на
    // другой — cross-site запрос, не top-level navigation; SameSite=Lax
    // браузер в такой ситуации не отправляет. None требует Secure=true
    // (спецификация не разрешает иначе) — тот же NODE_ENV определяет
    // оба флага согласованно. В dev два localhost-порта остаются
    // "same-site" по RFC (site = eTLD+1+scheme, не порт), 'lax' там
    // продолжает работать.
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(ADMIN_SESSION_COOKIE_NAME, result.token, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      expires: result.expiresAt,
      path: '/',
    });
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookies = parseCookieHeader(req.headers.cookie);
    const token = cookies[ADMIN_SESSION_COOKIE_NAME];
    if (token) {
      await this.adminAuth.logout(token);
    }
    const isProd = process.env.NODE_ENV === 'production';
    res.clearCookie(ADMIN_SESSION_COOKIE_NAME, {
      path: '/',
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
    });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AdminSessionGuard)
  async me(@Req() req: AdminAuthenticatedRequest) {
    return this.adminAuth.me(req.userId);
  }
}
