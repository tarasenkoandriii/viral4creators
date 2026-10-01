/**
 * Кто пришёл и из какого бота — чистая функция над заголовками и env
 * (гвард — тонкая обёртка, тесты гоняют это напрямую и через HTTP).
 *
 * Правила ТЗ помощника §4.1 «Несколько ботов в одном бэкенде»:
 *  1. Приложение — ТОЛЬКО из заголовка `X-Telegram-App`. Нет или чужое
 *     значение — отказ, а не «бот по умолчанию».
 *  2. initData проверяется HMAC-ом токена ИМЕННО этого приложения.
 *     Перебирать токены нельзя: тогда initData бота помощника открывала
 *     бы QA-маршруты (заголовок `qa` + подпись помощника прошли бы по
 *     второму токену). Подделать заголовок можно, подпись — нет: подпись
 *     одного бота токеном другого не сходится.
 *  3. Маршрут объявляет, какие приложения пускает (`@AllowApps`); `any` —
 *     оба (кабинет ядра).
 *  4. Дев-вход (`X-Dev-User-Id`) — только при `ALLOW_DEV_AUTH=true` и
 *     `NODE_ENV !== 'production'` — то же правило и та же функция, что в
 *     backend (shared/dev-login.ts, копия с проверкой).
 *
 * Токены и initData не попадают ни в текст ошибки, ни в лог: в лог идёт
 * только причина отказа валидатора (`hash mismatch`, `initData too old`).
 */

import {
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DEV_USER_HEADER,
  TELEGRAM_APP_HEADER,
  TELEGRAM_INIT_DATA_HEADER,
  TelegramApp,
  parseTelegramApp,
} from '../../brand';
import { isDevAuthAllowed } from '../../shared/dev-login';
import {
  TelegramInitDataInvalidError,
  TelegramInitDataUser,
  validateTelegramInitData,
} from '../../shared/telegram-init-data.util';
import type { AppScope, RequestIdentity } from './identity';

/**
 * Срок жизни initData — сутки, как у backend (умолчание
 * `validateTelegramInitData`). Задан явно: смена умолчания в источнике
 * не должна молча менять срок здесь.
 */
export const INIT_DATA_MAX_AGE_SECONDS = 86400;

/** Переменная с токеном бота — по приложению, одна на приложение. */
export const BOT_TOKEN_ENV: Readonly<Record<TelegramApp, string>> = {
  assist: 'ASSIST_BOT_TOKEN',
  qa: 'QA_BOT_TOKEN',
};

export type HeaderBag = Record<string, string | string[] | undefined>;

export interface AuthEnv {
  [key: string]: string | undefined;
}

export interface AuthOutcome {
  identity: RequestIdentity;
  /** Как подтверждена личность — для лога, не для решений. */
  via: 'initData' | 'dev';
}

/** Отказ с причиной для лога (сама причина клиенту не уходит). */
export class TelegramAuthRejected extends Error {
  constructor(
    readonly httpError: HttpException,
    readonly logReason: string,
  ) {
    super(logReason);
    this.name = 'TelegramAuthRejected';
  }
}

const REOPEN_MESSAGE =
  'Telegram не подтвердил вход — закройте приложение и откройте его в Telegram заново';

function header(headers: HeaderBag, name: string): string | undefined {
  // Express приводит имена заголовков к нижнему регистру.
  const v = headers[name.toLowerCase()];
  return typeof v === 'string' ? v : undefined;
}

function reject(error: HttpException, logReason: string): never {
  throw new TelegramAuthRejected(error, logReason);
}

/** Пускает ли маршрут это приложение. */
export function scopeAllows(scopes: readonly AppScope[], app: TelegramApp) {
  return scopes.includes('any') || scopes.includes(app);
}

/** Токен бота приложения — без запасного варианта «другой бот». */
export function botTokenFor(
  app: TelegramApp,
  env: AuthEnv,
): string | undefined {
  const token = env[BOT_TOKEN_ENV[app]]?.trim();
  return token ? token : undefined;
}

/** `X-Dev-User-Id` → telegramId: только положительное целое. */
function parseDevUserId(raw: string | undefined): bigint | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!/^[1-9][0-9]{0,18}$/.test(v)) return null;
  return BigInt(v);
}

export function authenticateTelegramRequest(
  headers: HeaderBag,
  scopes: readonly AppScope[],
  env: AuthEnv = process.env,
): AuthOutcome {
  const app = parseTelegramApp(header(headers, TELEGRAM_APP_HEADER));
  if (!app) {
    reject(
      new UnauthorizedException(
        'Не указано приложение — откройте его из бота в Telegram',
      ),
      `нет или неизвестен заголовок ${TELEGRAM_APP_HEADER}`,
    );
  }

  // До проверки подписи: ответ «не тот бот» ничего не раскрывает, а
  // считать HMAC для запроса, который всё равно не пустят, незачем.
  if (!scopeAllows(scopes, app)) {
    reject(
      new ForbiddenException(
        'Этот раздел открывается из другого бота — вернитесь в нужное приложение',
      ),
      `приложение ${app} не допущено к маршруту (${scopes.join(',')})`,
    );
  }

  const initData = header(headers, TELEGRAM_INIT_DATA_HEADER);
  if (initData) {
    const botToken = botTokenFor(app, env);
    if (!botToken) {
      // Fail-closed: без токена своего бота подпись не проверить, а
      // проверять чужим — и есть запрещённый перебор.
      reject(
        new ServiceUnavailableException(
          'Вход временно недоступен: бот приложения не настроен',
        ),
        `${BOT_TOKEN_ENV[app]} не задан`,
      );
    }
    let user: TelegramInitDataUser;
    try {
      ({ user } = validateTelegramInitData(initData, {
        botToken,
        maxAgeSeconds: INIT_DATA_MAX_AGE_SECONDS,
      }));
    } catch (err) {
      if (err instanceof TelegramInitDataInvalidError) {
        reject(
          new UnauthorizedException(REOPEN_MESSAGE),
          `initData (${app}) отклонён: ${err.message}`,
        );
      }
      throw err;
    }
    if (!Number.isSafeInteger(user.id) || user.id <= 0) {
      reject(
        new UnauthorizedException(REOPEN_MESSAGE),
        `initData (${app}): user.id не положительное целое`,
      );
    }
    return {
      via: 'initData',
      identity: {
        app,
        telegramId: BigInt(user.id),
        username: user.username ?? null,
        firstName: user.first_name ?? null,
        languageCode: user.language_code ?? null,
      },
    };
  }

  if (isDevAuthAllowed(env)) {
    const devId = parseDevUserId(header(headers, DEV_USER_HEADER));
    if (devId !== null) {
      return {
        via: 'dev',
        identity: {
          app,
          telegramId: devId,
          username: null,
          firstName: null,
          languageCode: null,
        },
      };
    }
  }

  reject(
    new UnauthorizedException(REOPEN_MESSAGE),
    `нет ${TELEGRAM_INIT_DATA_HEADER} (${app})`,
  );
}
