/**
 * TelegramIdentityMiddleware
 *
 * Опциональная, НЕ блокирующая идентификация по Telegram. Это ключевое
 * отличие от аналогичного `TelegramAuthGuard` в Devil's Advocate: там
 * Mini App без Telegram вообще не работает, и guard кидает 401, если нет
 * ни `X-Telegram-Init-Data`, ни dev-заголовка. Здесь — наоборот: продукт
 * как работал анонимно (сессия по UUID, без аккаунта) в обычном
 * браузере, так и должен продолжать работать, если Telegram вообще ни
 * при чём. Поэтому это middleware, а не guard: он никогда не отклоняет
 * запрос, только опционально проставляет `req.telegramUserId`, когда
 * идентификация возможна.
 *
 * Единственный случай, когда он всё-таки бросает — заголовок
 * `X-Telegram-Init-Data` ЕСТЬ, но подпись невалидна: раз клиент заявил,
 * что пришёл из Telegram, доверять этому без проверки подписи нельзя
 * (иначе подделать identity тривиально). Если заголовка нет вообще —
 * ошибки нет, запрос идёт дальше анонимным, как раньше.
 *
 * Порядок проверки источников identity (первый найденный побеждает):
 *   1. `X-Telegram-Init-Data` — внутри Telegram, самый сильный сигнал.
 *   2. `X-Dev-User-Id` — dev-обход (только ALLOW_DEV_AUTH=true).
 *   3. Cookie `user_session` — постоянный логин обычного браузера вне
 *      Telegram, см. modules/telegram-login. Проверяется последней,
 *      потому что первые два всегда сильнее и специфичнее источника
 *      запроса (сама TMA внутри Telegram эту cookie не ставит).
 *
 * См. doc/TELEGRAM-ADMIN.md.
 */

import {
  ForbiddenException,
  Injectable,
  NestMiddleware,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import {
  validateTelegramInitData,
  TelegramInitDataInvalidError,
} from './telegram-init-data.util';
import {
  parseCookieHeader,
  USER_SESSION_COOKIE_NAME,
} from '../telegram-login/cookie.util';
import { CSRF_REJECTED_MESSAGE, isOriginAllowed } from '../../common/csrf';
import { isDevAuthAllowed } from '../admin-auth/dev-login';

export interface TelegramIdentifiedRequest extends Request {
  /** Internal User.id (не telegramId), выставлен только если Telegram-
   * идентификация состоялась (initData или dev-bypass). Отсутствует для
   * обычных анонимных запросов — вызывающий код обязан это учитывать. */
  telegramUserId?: string;
}

@Injectable()
export class TelegramIdentityMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TelegramIdentityMiddleware.name);

  constructor(private readonly prisma: PrismaService) {}

  async use(
    req: TelegramIdentifiedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const rawInitData = req.headers['x-telegram-init-data'];
    if (rawInitData && !Array.isArray(rawInitData)) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (botToken) {
        try {
          const parsed = validateTelegramInitData(rawInitData, { botToken });
          const user = await this.prisma.user.upsert({
            where: { telegramId: String(parsed.user.id) },
            update: {},
            create: { telegramId: String(parsed.user.id) },
          });
          req.telegramUserId = user.id;
          return next();
        } catch (err) {
          if (err instanceof TelegramInitDataInvalidError) {
            this.logger.warn(`initData rejected: ${err.message}`);
            throw new UnauthorizedException('Invalid Telegram initData');
          }
          throw err;
        }
      }
      // Заголовок прислан, но TELEGRAM_BOT_TOKEN не настроен — не можем
      // проверить подпись. Не блокируем запрос целиком (продукт и так
      // не требует Telegram), просто игнорируем заголовок и продолжаем
      // анонимно; предупреждаем в логах, а не молчим.
      this.logger.warn(
        'X-Telegram-Init-Data получен, но TELEGRAM_BOT_TOKEN не настроен — игнорирую',
      );
    }

    const devUserId = await this.tryDevBypass(req);
    if (devUserId) {
      req.telegramUserId = devUserId;
      return next();
    }

    const cookieUserId = await this.tryCookieSession(req);
    if (cookieUserId) {
      // Личность из cookie — единственный источник, который браузер
      // прикладывает САМ, без участия нашего кода. Значит на ней и
      // только на ней возможна CSRF: страница злоумышленника отправляет
      // form-POST, браузер добавляет `user_session` (в проде она с
      // `SameSite=None`, потому что API и приложение на разных
      // доменах), и запрос выполняется от имени вошедшего человека —
      // соглашается с офертой, заводит проект, тратит деньги на пробу
      // голоса (Б-3.1). initData и dev-заголовок сюда не попадают:
      // их ставит только наш собственный клиент.
      //
      // Отказ — до того, как личность проставлена: запрос продолжать
      // анонимно тоже нельзя, иначе «отказ» превратится в тихую потерю
      // прав посреди операции.
      if (
        !isOriginAllowed(
          req.method ?? 'GET',
          req.headers.origin as string | undefined,
          process.env.CORS_ORIGIN,
        )
      ) {
        this.logger.warn(
          `CSRF: ${req.method} ${req.originalUrl} с Origin «${req.headers.origin ?? '—'}» отклонён`,
        );
        throw new ForbiddenException(CSRF_REJECTED_MESSAGE);
      }
      req.telegramUserId = cookieUserId;
    }

    next();
  }

  /**
   * Постоянный логин обычного браузера вне Telegram (кнопка «Войти через
   * Telegram» на frontend, см. modules/telegram-login). Та же cookie
   * (`user_session`), что резолвит `GET /telegram-login/me` — здесь
   * читается напрямую через Prisma, а не через TelegramLoginService,
   * чтобы не заводить лишнюю модульную зависимость ради одного запроса.
   * Как и dev-bypass — никогда не бросает: истёкшая или отсутствующая
   * cookie просто оставляет запрос анонимным.
   */
  private async tryCookieSession(req: Request): Promise<string | null> {
    const cookies = parseCookieHeader(req.headers.cookie);
    const token = cookies[USER_SESSION_COOKIE_NAME];
    if (!token) return null;

    const session = await this.prisma.userSession.findUnique({
      where: { token },
    });
    if (!session || session.expiresAt <= new Date()) return null;

    return session.userId;
  }

  /**
   * DEV bypass — активен только при ALLOW_DEV_AUTH=true (та же
   * переменная, что открывает `POST /admin/auth/dev-login`, см.
   * modules/admin-auth/dev-login.ts). Заголовок X-Dev-User-Id трактуется
   * как условный telegramId; тот же префикс "dev-", что использует
   * admin dev-login, — одинаковый devUserId в TMA и в админке даёт
   * ОДНОГО пользователя.
   */
  private async tryDevBypass(req: Request): Promise<string | null> {
    // Два независимых предохранителя, а не один (Б-3.9). Раньше здесь
    // проверялся только `ALLOW_DEV_AUTH`, тогда как у админского
    // dev-входа условий было два, и `doc/DEPLOYMENT.md` успокаивал
    // «двойной предохранитель и так закрывает» — для ЭТОГО обхода это
    // было неправдой: утёкшая в прод переменная означала подделку
    // личности одним заголовком.
    if (!isDevAuthAllowed(process.env)) return null;

    const devUserId = req.headers['x-dev-user-id'];
    if (!devUserId || Array.isArray(devUserId)) return null;

    const user = await this.prisma.user.upsert({
      where: { telegramId: `dev-${devUserId}` },
      update: {},
      create: { telegramId: `dev-${devUserId}` },
    });

    return user.id;
  }
}
