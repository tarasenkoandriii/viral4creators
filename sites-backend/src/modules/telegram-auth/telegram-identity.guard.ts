/**
 * TelegramIdentityGuard — ГЛОБАЛЬНЫЙ гвард sites-backend (APP_GUARD в
 * TelegramAuthModule).
 *
 * Отличие от backend: там middleware не блокирует (генератор работает и
 * анонимно). Здесь анонимных маршрутов кабинета нет, поэтому закрыто всё,
 * что не объявило явно:
 *  - `@AllowApps(...)` — кого пускать (проверка — authenticate.ts);
 *  - `@PublicRoute('причина')` — без Telegram (health, вебхуки, виджет).
 * Нет ни того, ни другого — 403 и ошибка в лог: это забытый декоратор, а
 * не запрос злоумышленника. Оба сразу — тоже 403: противоречие в коде
 * решать «в пользу открытости» нельзя.
 *
 * На запрос кладёт `req.identity` (identity.ts — контракт для site-core).
 *
 * Два источника личности (Э0-W):
 *  1. initData Telegram (`X-Telegram-Init-Data`) — TMA; правила —
 *     authenticate.ts, путь не менялся;
 *  2. cookie веб-кабинета (вход виджетом в обычном браузере) — только если
 *     initData в запросе НЕТ: initData приоритетнее (TMA, открытая на том
 *     же домене, где осталась cookie, работает от своей подписи).
 *     Личность — того же формата, `app: 'assist'`; `@AllowApps` — как
 *     обычно; на изменяющих методах — барьеры CSRF (web/web-request.ts).
 */

export const WEB_SESSION_INVALID_MESSAGE =
  'Сессия веб-кабинета истекла или завершена — войдите через Telegram заново';
const WEB_CSRF_MESSAGE =
  'Запрос пришёл с чужого сайта и отклонён (защита от CSRF)';
const WEB_APP_MESSAGE =
  'Веб-кабинет открывает только разделы помощника — откройте этот раздел в Telegram';

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { TELEGRAM_INIT_DATA_HEADER, WEB_SESSION_COOKIE } from '../../brand';
import { ALLOW_APPS_KEY, PUBLIC_ROUTE_KEY } from './allow-apps.decorator';
import {
  TelegramAuthRejected,
  authenticateTelegramRequest,
  scopeAllows,
} from './authenticate';
import type { AppScope, IdentifiedRequest } from './identity';
import type { WebIdentifiedRequest } from './web/web-identity';
import {
  WEB_APP,
  checkWebRequest,
  readSessionToken,
  sessionCookieOptions,
} from './web/web-request';
import { WebSessionService } from './web/web-session.service';

const MISCONFIGURED_MESSAGE =
  'Доступ к этому разделу не настроен. Если ошибка повторяется, сообщите в поддержку.';

@Injectable()
export class TelegramIdentityGuard implements CanActivate {
  private readonly logger = new Logger(TelegramIdentityGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly webSessions: WebSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Гвард — для HTTP; другие транспорты в проекте не заведены.
    if (context.getType() !== 'http') return false;

    const targets = [context.getHandler(), context.getClass()];
    const scopes = this.reflector.getAllAndOverride<AppScope[] | undefined>(
      ALLOW_APPS_KEY,
      targets,
    );
    const publicReason = this.reflector.getAllAndOverride<string | undefined>(
      PUBLIC_ROUTE_KEY,
      targets,
    );
    const req = context.switchToHttp().getRequest<Request>();
    const where = `${req.method} ${req.path}`;

    if (publicReason !== undefined && scopes !== undefined) {
      this.logger.error(
        `${where}: одновременно @PublicRoute и @AllowApps — маршрут закрыт`,
      );
      throw new ForbiddenException(MISCONFIGURED_MESSAGE);
    }
    if (publicReason !== undefined) return true;
    if (!scopes || scopes.length === 0) {
      this.logger.error(
        `${where}: нет @AllowApps(...) или @PublicRoute(...) — маршрут закрыт по умолчанию`,
      );
      throw new ForbiddenException(MISCONFIGURED_MESSAGE);
    }

    const initData = req.headers[TELEGRAM_INIT_DATA_HEADER.toLowerCase()];
    const webToken = initData
      ? undefined
      : readSessionToken(req.headers.cookie);
    if (webToken !== undefined) {
      const res = context.switchToHttp().getResponse<Response>();
      return this.authenticateWeb(req, res, webToken, scopes, where);
    }

    try {
      const { identity, via } = authenticateTelegramRequest(
        req.headers,
        scopes,
        process.env,
      );
      (req as IdentifiedRequest).identity = identity;
      if (via === 'dev') {
        this.logger.debug(`${where}: дев-вход (${identity.app})`);
      }
      return true;
    } catch (err) {
      if (err instanceof TelegramAuthRejected) {
        this.logger.warn(`${where}: ${err.logReason}`);
        throw err.httpError;
      }
      throw err;
    }
  }

  /** Путь cookie веб-кабинета: барьеры CSRF → приложение → сессия. */
  private async authenticateWeb(
    req: Request,
    res: Response,
    token: string,
    scopes: readonly AppScope[],
    where: string,
  ): Promise<boolean> {
    const env = process.env;
    const failure = checkWebRequest(req.method, req.headers, env);
    if (failure) {
      this.logger.warn(`${where}: веб-кабинет: ${failure.logReason}`);
      throw new ForbiddenException({
        message:
          failure.code === 'WEB_APP_MISMATCH'
            ? WEB_APP_MESSAGE
            : WEB_CSRF_MESSAGE,
        code: failure.code,
      });
    }
    // До базы: маршрут QA cookie веб-кабинета не откроет ни при какой сессии.
    if (!scopeAllows(scopes, WEB_APP)) {
      this.logger.warn(
        `${where}: веб-кабинет (${WEB_APP}) не допущен к маршруту (${scopes.join(',')})`,
      );
      throw new ForbiddenException({
        message: WEB_APP_MESSAGE,
        code: 'WEB_APP_MISMATCH',
      });
    }
    const resolved = await this.webSessions.resolve(token, WEB_APP);
    if (!resolved) {
      // Мёртвую cookie — убрать, чтобы фронт не ходил с ней по кругу.
      res.clearCookie(WEB_SESSION_COOKIE, sessionCookieOptions(env));
      this.logger.warn(`${where}: веб-сессия не найдена, отозвана или истекла`);
      throw new UnauthorizedException({
        message: WEB_SESSION_INVALID_MESSAGE,
        code: 'WEB_SESSION_INVALID',
      });
    }
    const { session, renewedUntil } = resolved;
    if (renewedUntil) {
      res.cookie(
        WEB_SESSION_COOKIE,
        token,
        sessionCookieOptions(env, renewedUntil),
      );
    }
    const webReq = req as WebIdentifiedRequest;
    webReq.identity = {
      app: WEB_APP,
      telegramId: session.telegramId,
      username: session.username,
      firstName: session.firstName,
      languageCode: null,
    };
    webReq.webSession = { id: session.id, expiresAt: session.expiresAt };
    return true;
  }
}
