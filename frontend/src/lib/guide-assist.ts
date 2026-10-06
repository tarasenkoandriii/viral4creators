/**
 * Гид мастера в режиме «Админка» помощника платформы (Э-С Ш6) — чистая
 * часть: разбор ответа `GET /guide-assist/config`, атрибуты загрузчика,
 * расписание обновления employee-JWT.
 *
 * TMA генератора здесь — «админка заказчика» для тенанта viral4creators:
 * загрузчик платформы с `data-mode="admin"` рисует кнопку «Помічник» и
 * iframe чата на origin `wa.`; личность — JWT, который подписывает НАШ
 * бэкенд (`POST /guide-assist/identity`) и который мы отдаём загрузчику
 * функцией `V4CAssist('identify-admin', jwt)` (В-29: `data-identity-endpoint`
 * не подходит — бэкенд TMA на другом origin, а загрузчик берёт endpoint
 * только со своего).
 *
 * Без DOM и сети — под `scripts/guide-assist.test.ts`.
 */

export type GuideAssistConfig =
  | { engine: 'legacy' }
  | { engine: 'assist'; pk: string; origin: string };

const LEGACY: GuideAssistConfig = { engine: 'legacy' };
const PK_RE = /^pk_(live|test)_[A-Za-z0-9_]{1,70}$/;

/** Глобальная функция загрузчика платформы (`WIDGET_GLOBAL`). */
export const GUIDE_ASSIST_GLOBAL = 'V4CAssist';
/** id тега загрузчика — чтобы не вставить его дважды. */
export const GUIDE_ASSIST_SCRIPT_ID = 'v4c-guide-assist-loader';
/** Обновить JWT за столько до истечения (как у iframe `wa.` — 90 с). */
export const GUIDE_JWT_REFRESH_LEAD_MS = 90_000;
/** Не чаще, чем раз в 15 с (защита от часов, уехавших вперёд). */
export const GUIDE_JWT_MIN_DELAY_MS = 15_000;

/**
 * Origin «Админки»: только `https://хост` без пути/порта/логина; для
 * тестового ключа — ещё `http://localhost:порт` (стенд).
 */
export function assistOriginOf(raw: unknown, pk: string): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  if (u.protocol === 'https:' && u.port === '') return u.origin;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol === 'http:' && local && pk.startsWith('pk_test_'))
    return u.origin;
  return null;
}

/**
 * Ответ сервера → конфигурация. Всё незнакомое, кривое или неполное —
 * старый гид: «Админка» включается только целиком.
 */
export function parseGuideAssistConfig(raw: unknown): GuideAssistConfig {
  if (!raw || typeof raw !== 'object') return LEGACY;
  const o = raw as Record<string, unknown>;
  if (o.engine !== 'assist') return LEGACY;
  if (typeof o.pk !== 'string' || !PK_RE.test(o.pk)) return LEGACY;
  const origin = assistOriginOf(o.origin, o.pk);
  if (!origin) return LEGACY;
  return { engine: 'assist', pk: o.pk, origin };
}

/** Язык окна помощника: у виджета платформы — uk/ru/en. */
export function guideAssistLang(locale: string): 'uk' | 'ru' | 'en' {
  const l = (locale || '').slice(0, 2).toLowerCase();
  return l === 'uk' || l === 'ru' ? l : 'en';
}

/** Атрибуты тега загрузчика «Админки». */
export function loaderAttributes(
  cfg: Extract<GuideAssistConfig, { engine: 'assist' }>,
  locale: string
): { src: string; attrs: Record<string, string> } {
  return {
    src: `${cfg.origin}/v1/loader.js`,
    attrs: {
      id: GUIDE_ASSIST_SCRIPT_ID,
      'data-site': cfg.pk,
      'data-mode': 'admin',
      'data-lang': guideAssistLang(locale),
    },
  };
}

/** JWT ответа `identity` — три base64url-части, `exp` — секунды. */
export function parseIdentity(
  raw: unknown
): { jwt: string; exp: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.jwt !== 'string' ||
    o.jwt.length > 4096 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(o.jwt)
  )
    return null;
  if (typeof o.exp !== 'number' || !Number.isFinite(o.exp)) return null;
  return { jwt: o.jwt, exp: o.exp };
}

/** Повтор выдачи JWT после сбоя сети или сервера. */
export const GUIDE_JWT_RETRY_MS = 30_000;

/**
 * Отказ `POST /guide-assist/identity` → что делать окну помощника.
 * `off` — личности нет (вышел: 401/403) или «Админку» ему выключили
 * (404 `GUIDE_ASSIST_DISABLED`): `logout`, окно гаснет и чистит диалог.
 * `retry` — сеть, 429, 5xx: окно НЕ гасить (иначе один сбой сети гасил
 * помощника до перезагрузки — аудит Ш6), повторить через
 * `GUIDE_JWT_RETRY_MS`; платформа сама отвергнет истёкший JWT.
 */
export function identityFailureOf(status: unknown): 'off' | 'retry' {
  return status === 401 || status === 403 || status === 404 ? 'off' : 'retry';
}

/**
 * Событие окна: личность мини-аппа сменилась (вход или выход через
 * кнопку Telegram в обычном браузере). Без него окно «Админки» до ~9 мин
 * показывало бы диалог и факты ПРЕДЫДУЩЕГО человека на общем устройстве
 * (аудит Ш6) — `GuideAssistMount` по нему делает `logout` и заново
 * спрашивает конфигурацию и JWT.
 */
export const GUIDE_IDENTITY_EVENT = 'v4c:identity-changed';

export function notifyIdentityChanged(
  w: { dispatchEvent(e: Event): boolean } = window
): void {
  w.dispatchEvent(new Event(GUIDE_IDENTITY_EVENT));
}

/** Через сколько мс просить свежий JWT. */
export function refreshDelayMs(expSec: number, nowMs: number): number {
  return Math.max(
    GUIDE_JWT_MIN_DELAY_MS,
    expSec * 1000 - GUIDE_JWT_REFRESH_LEAD_MS - nowMs
  );
}

type QueueFn = ((...args: unknown[]) => void) & { q?: unknown[][] };

/**
 * Вызов `V4CAssist(...)` до и после загрузки: до — в очередь `q`, которую
 * чанк «Админки» проигрывает при старте (`widget/src/admin/index.ts`).
 */
export function callAssist(
  w: Record<string, unknown>,
  ...args: unknown[]
): void {
  let fn = w[GUIDE_ASSIST_GLOBAL] as QueueFn | undefined;
  if (typeof fn !== 'function') {
    const stub: QueueFn = (...a: unknown[]) => {
      (stub.q = stub.q || []).push(a);
    };
    w[GUIDE_ASSIST_GLOBAL] = stub;
    fn = stub;
  }
  fn(...args);
}
