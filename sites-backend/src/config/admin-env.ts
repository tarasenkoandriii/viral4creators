/**
 * Переменные окружения «Админки» (Э7, ТЗ §4.12, §5.6) — одно место чтения.
 *
 *  - ASSIST_ADMIN_WIDGET_ORIGIN — origin iframe чата сотрудника
 *    (`https://wa.<домен>`; временно `https://assist-wa.viral4creators.app`,
 *    doc/DEPLOYMENT.md §6.19). ОТДЕЛЬНЫЙ от ASSIST_WIDGET_ORIGIN (У-13):
 *    совпадение — ошибка конфигурации (validateAdminEnv), иначе XSS в
 *    публичном чате доставал бы сессию сотрудника. Без переменной —
 *    заглушка бренда (в проде — ошибка конфигурации).
 *  - ASSIST_SECRETS_KEY (+ ASSIST_SECRETS_KEY_VERSION, ASSIST_SECRETS_KEYS_OLD)
 *    — ключ секретов коннекторов и подписи employee-JWT
 *    (assist-admin-mode/admin-secrets-crypto.ts).
 */
import { WIDGET_ADMIN_ORIGIN_DEFAULT } from '../brand';
import { widgetOrigin } from './widget-env';

function originOf(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function adminWidgetOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    originOf(env.ASSIST_ADMIN_WIDGET_ORIGIN) ?? WIDGET_ADMIN_ORIGIN_DEFAULT
  );
}

/** Проблемы конфигурации «Админки» (для чек-листа деплоя и тестов). */
export function validateAdminEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  if (!originOf(env.ASSIST_ADMIN_WIDGET_ORIGIN)) {
    out.push('ASSIST_ADMIN_WIDGET_ORIGIN не задана или не https-origin');
  } else if (adminWidgetOrigin(env) === widgetOrigin(env)) {
    out.push(
      'ASSIST_ADMIN_WIDGET_ORIGIN совпадает с ASSIST_WIDGET_ORIGIN — «Админке» нужен отдельный origin (§4.12, У-13)',
    );
  }
  if (!env.ASSIST_SECRETS_KEY?.trim()) {
    out.push('ASSIST_SECRETS_KEY не задан — секреты «Админки» недоступны');
  }
  return out;
}

// ── Э-С Ш6: «Админка», которая сама открывается внутри Telegram ─────────
//
// TMA генератора viral4creators — «админка» своего тенанта (Ш6). В
// мобильных клиентах Telegram мини-апп — страница верхнего уровня, но в
// Telegram Web (web.telegram.org/k, /a) он сам живёт в iframe, а
// `frame-ancestors` проверяется по ВСЕМ предкам: без origin Telegram Web
// окно помощника там не откроется. Добавляется только сайтам с флагом
// «админка — Telegram Mini App» (`assist_admin_settings.adminTmaFrame`,
// кабинет «Админки»; заход 10, Р-З10-16) или из списка env
// `ASSIST_ADMIN_TMA_SITE_IDS` (OR, до удаления env) — и только вместе с их
// verified-хостами админки: чужая страница внутри Telegram Web (её origin
// тоже предок) встроить чат сотрудника по-прежнему не может.

/** Origin-ы веб-клиентов Telegram (все версии — на одном домене). */
export const TELEGRAM_WEB_ORIGINS: readonly string[] = [
  'https://web.telegram.org',
];

/** Сайты, чья «админка» — Telegram Mini App (id через запятую). */
export function adminTmaSiteIds(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  return new Set(
    (env.ASSIST_ADMIN_TMA_SITE_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s)),
  );
}

/**
 * Предки окна сотрудника сверх verified-хостов админки: Telegram Web —
 * только сайту с флагом `adminTmaFrame` или из списка env (Р-З10-16: env —
 * OR до удаления) и только если свои хосты уже есть (пустой список хостов
 * остаётся `'none'`).
 */
export function extraAdminAncestors(
  siteId: string,
  hostAncestors: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  siteFlag = false,
): string[] {
  if (hostAncestors.length === 0) return [];
  return siteFlag === true || adminTmaSiteIds(env).has(siteId)
    ? [...TELEGRAM_WEB_ORIGINS]
    : [];
}
