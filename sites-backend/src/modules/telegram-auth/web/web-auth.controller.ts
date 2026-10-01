/**
 * Вход в веб-кабинет (тот же `assist/` в обычном браузере) виджетом
 * Telegram — по образцу главной админки (backend/src/modules/admin-auth),
 * но со своей таблицей сессий и cookie `SameSite=Lax` (фронт ходит через
 * same-origin прокси, cookie первосторонняя).
 *
 *   POST /sites/auth/web-login      — данные виджета → сессия + cookie
 *   POST /sites/auth/web-dev-login  — dev-стенд без виджета (иначе 404)
 *   POST /sites/auth/logout         — отозвать эту сессию, стереть cookie
 *   POST /sites/auth/logout-all     — отозвать все веб-сессии человека
 *   GET  /sites/auth/me             — кто вошёл
 *
 * Токен сессии — только в HttpOnly-cookie, в теле ответа его нет (иначе
 * он был бы доступен JS кабинета — то, от чего HttpOnly и защищает).
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import { WEB_SESSION_COOKIE } from '../../../brand';
import { hashIpWithDailySalt } from '../../../shared/assist-chat-core/ip-hash';
import { isDevAuthAllowed } from '../../../shared/dev-login';
import { AllowApps, PublicRoute } from '../allow-apps.decorator';
import { BOT_TOKEN_ENV, botTokenFor } from '../authenticate';
import type { WebIdentifiedRequest } from './web-identity';
import {
  LoginRateLimiter,
  WidgetLoginRejected,
  verifyWidgetLogin,
} from './web-login';
import {
  WEB_APP,
  checkWebRequest,
  clientIp,
  readSessionToken,
  sessionCookieOptions,
} from './web-request';
import { WebSessionService } from './web-session.service';

const LOGIN_REJECTED_MESSAGE =
  'Telegram не подтвердил вход — нажмите «Войти через Telegram» ещё раз';
const CSRF_MESSAGE = 'Запрос пришёл с чужого сайта и отклонён (защита от CSRF)';

export interface WebMeResponse {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  app: 'assist';
  /** `web` — по cookie; `telegram` — по initData (TMA). */
  via: 'web' | 'telegram';
  /** Конец веб-сессии (ISO); `null` при входе через initData. */
  sessionExpiresAt: string | null;
}

@Controller('sites/auth')
export class WebAuthController {
  private readonly logger = new Logger(WebAuthController.name);
  /** Один на инстанс — см. шапку LoginRateLimiter. */
  private readonly limiter = new LoginRateLimiter(10, 60_000);

  constructor(private readonly sessions: WebSessionService) {}

  @Post('web-login')
  @HttpCode(HttpStatus.OK)
  @PublicRoute(
    'вход в веб-кабинет: личность ещё не установлена, проверяется подпись виджета',
  )
  async webLogin(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertSameSite(req);
    const ip = clientIp(req);
    this.rateLimit(ip);

    const botToken = botTokenFor(WEB_APP, process.env);
    if (!botToken) {
      this.logger.error(
        `${BOT_TOKEN_ENV[WEB_APP]} не задан — вход в веб-кабинет закрыт`,
      );
      throw new ServiceUnavailableException({
        message: 'Вход временно недоступен: бот приложения не настроен',
        code: 'BOT_NOT_CONFIGURED',
      });
    }
    let user;
    try {
      user = verifyWidgetLogin(body, botToken);
    } catch (err) {
      if (err instanceof WidgetLoginRejected) {
        this.logger.warn(`web-login отклонён: ${err.logReason}`);
        throw new UnauthorizedException({
          message: LOGIN_REJECTED_MESSAGE,
          code: 'TELEGRAM_LOGIN_INVALID',
        });
      }
      throw err;
    }
    const issued = await this.sessions.issue({
      telegramId: user.telegramId,
      app: WEB_APP,
      username: user.username,
      firstName: user.firstName,
      userAgent: headerString(req.headers['user-agent']),
      ipHash: ipHashFor(ip, botToken),
    });
    res.cookie(
      WEB_SESSION_COOKIE,
      issued.token,
      sessionCookieOptions(process.env, issued.expiresAt),
    );
    return {
      user: {
        telegramId: user.telegramId.toString(),
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        photoUrl: user.photoUrl,
      },
      expiresAt: issued.expiresAt.toISOString(),
    };
  }

  /**
   * Dev-стенд: виджет Telegram на localhost не работает (домен задаётся
   * боту через /setdomain), поэтому вход без подписи — только при
   * `ALLOW_DEV_AUTH=true` и не production (shared/dev-login). Иначе 404,
   * как несуществующий маршрут (то же, что admin dev-login backend).
   */
  @Post('web-dev-login')
  @HttpCode(HttpStatus.OK)
  @PublicRoute('dev-вход в веб-кабинет: только ALLOW_DEV_AUTH вне production')
  async webDevLogin(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!isDevAuthAllowed(process.env)) {
      throw new NotFoundException('Cannot POST /sites/auth/web-dev-login');
    }
    this.assertSameSite(req);
    this.rateLimit(clientIp(req));
    const raw =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).devUserId
        : undefined;
    const v = String(raw ?? '123').trim();
    if (!/^[1-9][0-9]{0,15}$/.test(v)) {
      throw new UnauthorizedException({
        message: 'devUserId — положительное целое',
        code: 'TELEGRAM_LOGIN_INVALID',
      });
    }
    this.logger.warn(
      `WEB DEV LOGIN — сессия веб-кабинета для ${v} без Telegram`,
    );
    const issued = await this.sessions.issue({
      telegramId: BigInt(v),
      app: WEB_APP,
      username: null,
      firstName: null,
      userAgent: headerString(req.headers['user-agent']),
    });
    res.cookie(
      WEB_SESSION_COOKIE,
      issued.token,
      sessionCookieOptions(process.env, issued.expiresAt),
    );
    return {
      user: {
        telegramId: v,
        username: null,
        firstName: null,
        lastName: null,
        photoUrl: null,
      },
      expiresAt: issued.expiresAt.toISOString(),
    };
  }

  /**
   * Открыт без личности: выйти должно быть можно и с уже мёртвой cookie
   * (иначе фронт не сможет её стереть). Барьеры CSRF — те же: чужая
   * страница не должна уметь выкинуть человека из кабинета.
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @PublicRoute('выход из веб-кабинета: работает и с недействительной cookie')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.assertSameSite(req);
    await this.sessions.revoke(readSessionToken(req.headers.cookie));
    res.clearCookie(WEB_SESSION_COOKIE, sessionCookieOptions(process.env));
    return { ok: true };
  }

  /**
   * «Выйти на всех устройствах» — для себя. Пускает и cookie, и initData
   * помощника (из TMA тоже можно завершить веб-сессии).
   */
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @AllowApps('assist')
  async logoutAll(
    @Req() req: WebIdentifiedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const revoked = await this.sessions.revokeAll(req.identity.telegramId);
    res.clearCookie(WEB_SESSION_COOKIE, sessionCookieOptions(process.env));
    return { ok: true, revoked };
  }

  @Get('me')
  @AllowApps('assist')
  me(@Req() req: WebIdentifiedRequest): WebMeResponse {
    const { identity, webSession } = req;
    return {
      telegramId: identity.telegramId.toString(),
      username: identity.username,
      firstName: identity.firstName,
      app: WEB_APP,
      via: webSession ? 'web' : 'telegram',
      sessionExpiresAt: webSession ? webSession.expiresAt.toISOString() : null,
    };
  }

  private assertSameSite(req: Request) {
    const failure = checkWebRequest(req.method, req.headers, process.env);
    if (failure) {
      this.logger.warn(`${req.method} ${req.path}: ${failure.logReason}`);
      throw new ForbiddenException({
        message: CSRF_MESSAGE,
        code: failure.code,
      });
    }
  }

  private rateLimit(ip: string) {
    const waitMs = this.limiter.hit(ip);
    if (waitMs !== null) {
      throw new HttpException(
        {
          message: 'Слишком много попыток входа — подождите минуту',
          code: 'LOGIN_RATE_LIMITED',
          retryAfterMs: waitMs,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

function headerString(v: string | string[] | undefined): string | null {
  return typeof v === 'string' && v ? v : null;
}

/**
 * Хеш IP для строки сессии. Нового секрета не заводим: соль выводится из
 * токена бота (одностороннее, сам токен из хеша не восстановить), плюс
 * суточная соль общего `hashIpWithDailySalt` — сырой IP не хранится, а
 * перебор 2^32 адресов без секрета невозможен.
 */
function ipHashFor(ip: string, botToken: string): string {
  const salt = createHash('sha256')
    .update(`v4c-web-session-ip:${botToken}`)
    .digest('hex');
  return hashIpWithDailySalt(ip, salt);
}
