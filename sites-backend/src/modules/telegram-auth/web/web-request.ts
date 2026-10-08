/**
 * Правила запроса веб-кабинета (вход виджетом Telegram в обычном браузере,
 * сессия — HttpOnly-cookie). Чистые функции над методом, заголовками и env:
 * гвард и контроллер входа — тонкие обёртки, тесты гоняют это напрямую.
 *
 * ## Почему cookie здесь вообще безопасна
 *
 * Фронт ходит в API через same-origin прокси (Vercel rewrite `/api/*` →
 * sites-backend в проекте `assist`), поэтому cookie первосторонняя:
 * `SameSite=Lax` (Safari с его ITP её не режет), `Secure`, `Path=/`.
 * `Lax` уже не отдаёт cookie кросс-сайтовому POST — но «сайт» это eTLD+1,
 * а не origin: соседний поддомен того же сайта (или `*.vercel.app` при
 * неудачной схеме доменов) для браузера same-site. Поэтому два барьера
 * поверх `Lax`, для каждого изменяющего метода:
 *
 *  1. обязательный заголовок `X-Telegram-App: assist` — HTML-форма его
 *     поставить не может, а `fetch` со своим заголовком на чужой origin
 *     требует preflight, который CORS не пропустит;
 *  2. `Origin` (или, если браузер его не прислал, origin из `Referer`)
 *     обязан быть в `WEB_CABINET_ORIGINS` — точное сравнение, без
 *     подстановок вида `*.vercel.app` (то же решение, что backend
 *     `common/csrf.ts`: право менять данные по cookie не раздаётся
 *     превью-доменам молча).
 *
 * Fail-политика списка — как backend `common/csrf.ts`: пустой список в
 * проде — отказ (барьер не может выключиться забытой переменной), на
 * dev-стенде — пропуск. Отличие от backend: запрос БЕЗ `Origin` и без
 * `Referer` здесь отклоняется — cookie есть только у браузера, а браузер
 * на не-safe запросе `Origin` шлёт всегда; «не-браузерный клиент с
 * cookie» — это скорее подделка, чем curl.
 */

import type { CookieOptions } from 'express';
import {
  TELEGRAM_APP_HEADER,
  WEB_SESSION_COOKIE,
  parseTelegramApp,
} from '../../../brand';
import { clientIp as sharedClientIp } from '../../../shared/client-ip';
import { parseCookieHeader } from '../../../shared/cookie.util';
import { isDevAuthAllowed } from '../../../shared/dev-login';
import type { HeaderBag } from '../authenticate';

/** Веб-кабинет принадлежит приложению помощника (решение координатора). */
export const WEB_APP = 'assist' as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string | undefined): boolean {
  return SAFE_METHODS.has((method || 'GET').toUpperCase());
}

function header(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return typeof v === 'string' ? v : undefined;
}

export interface WebEnv {
  WEB_CABINET_ORIGINS?: string;
  NODE_ENV?: string;
  ALLOW_DEV_AUTH?: string;
  [key: string]: string | undefined;
}

/** `WEB_CABINET_ORIGINS` → список origin без хвостовых слэшей. */
export function parseWebOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
}

/** Отказ веб-барьера: машинный код для фронта и причина для лога. */
export interface WebCheckFailure {
  code: 'WEB_APP_MISMATCH' | 'WEB_CSRF_REJECTED';
  logReason: string;
}

/**
 * Заголовок приложения в веб-режиме: если прислан — только `assist`
 * (cookie веб-кабинета не открывает QA ни под каким заголовком); на
 * изменяющем методе — обязателен (барьер CSRF №1).
 */
export function checkWebAppHeader(
  method: string | undefined,
  headers: HeaderBag,
): WebCheckFailure | null {
  const raw = header(headers, TELEGRAM_APP_HEADER);
  if (raw === undefined) {
    return isSafeMethod(method)
      ? null
      : {
          code: 'WEB_CSRF_REJECTED',
          logReason: `cookie-запрос ${method} без ${TELEGRAM_APP_HEADER}`,
        };
  }
  if (parseTelegramApp(raw) !== WEB_APP) {
    return {
      code: 'WEB_APP_MISMATCH',
      logReason: `cookie веб-кабинета с ${TELEGRAM_APP_HEADER}=${raw.slice(0, 16)}`,
    };
  }
  return null;
}

/** origin из `Origin`, иначе из `Referer`; `null`-origin — как отсутствие. */
export function requestSourceOrigin(headers: HeaderBag): string | null {
  const origin = header(headers, 'origin')?.trim();
  if (origin && origin !== 'null') {
    return origin.replace(/\/+$/, '').toLowerCase();
  }
  const referer = header(headers, 'referer')?.trim();
  if (referer) {
    try {
      return new URL(referer).origin.toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
}

/** Барьер CSRF №2: источник изменяющего запроса — из списка кабинета. */
export function checkWebOrigin(
  method: string | undefined,
  headers: HeaderBag,
  env: WebEnv,
): WebCheckFailure | null {
  if (isSafeMethod(method)) return null;
  const allowed = parseWebOrigins(env.WEB_CABINET_ORIGINS);
  if (allowed.length === 0) {
    if (env.NODE_ENV !== 'production') return null;
    return {
      code: 'WEB_CSRF_REJECTED',
      logReason: 'WEB_CABINET_ORIGINS не задан в production — запрос закрыт',
    };
  }
  const source = requestSourceOrigin(headers);
  if (!source) {
    return {
      code: 'WEB_CSRF_REJECTED',
      logReason: `cookie-запрос ${method} без Origin и Referer`,
    };
  }
  if (!allowed.includes(source)) {
    return {
      code: 'WEB_CSRF_REJECTED',
      logReason: `чужой источник ${source.slice(0, 80)}`,
    };
  }
  return null;
}

/** Оба барьера разом — для маршрутов входа/выхода и гварда. */
export function checkWebRequest(
  method: string | undefined,
  headers: HeaderBag,
  env: WebEnv,
): WebCheckFailure | null {
  return (
    checkWebAppHeader(method, headers) ?? checkWebOrigin(method, headers, env)
  );
}

/** Токен сессии из заголовка Cookie (или `undefined`). */
export function readSessionToken(
  cookieHeader: string | string[] | undefined,
): string | undefined {
  const raw = Array.isArray(cookieHeader)
    ? cookieHeader.join('; ')
    : cookieHeader;
  const v = parseCookieHeader(raw)[WEB_SESSION_COOKIE];
  return v ? v : undefined;
}

/**
 * Атрибуты cookie. `Secure` снимается только на dev-стенде
 * (`ALLOW_DEV_AUTH=true` и не production): Safari не сохраняет Secure-cookie
 * для `http://localhost`, а виджет Telegram на localhost не работает вовсе
 * (вход там — dev-login).
 */
export function sessionCookieOptions(
  env: WebEnv,
  expiresAt?: Date,
): CookieOptions {
  return {
    httpOnly: true,
    secure: !isDevAuthAllowed(env),
    sameSite: 'lax',
    path: '/',
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

/**
 * Адрес клиента — общее правило backend (`shared/client-ip.ts`, копия
 * `backend/src/common/client-ip.ts`; П-С1 захода 10, Р-З10-4):
 *  - на Vercel (`VERCEL` задан платформой) — первый элемент
 *    `x-forwarded-for`, как раньше (через rewrite проекта `assist` Vercel
 *    передаёт адрес посетителя тем же заголовком);
 *  - вне Vercel (Docker, локальный запуск) XFF читается, только если
 *    соединение пришло от прокси из `TRUSTED_PROXY_CIDRS` (справа налево,
 *    доверенные звенья пропускаются); иначе — адрес сокета. До захода 10
 *    здесь безусловно брался первый XFF — клиент подставлял любой адрес и
 *    получал новое окно каждого лимита по адресу.
 */
export function clientIp(
  req: {
    headers: HeaderBag;
    ip?: string;
    socket?: { remoteAddress?: string };
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  return sharedClientIp(req, env);
}
