// СГЕНЕРИРОВАНО scripts/sync-worker-shared.mjs — не править.
// Источник: backend/src/common/sites-internal-signature.ts. Правка — в источнике, затем
// `node scripts/sync-worker-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Подпись внутреннего API «генератор → sites-backend» (Э-С, шаг Ш1;
 * предложение П-С3 `docs-tz/SECURITY-PROPOSALS-2026-10-02.md`).
 *
 * ЧИСТЫЙ модуль: копия лежит в `sites-backend/src/shared/` (скрипт
 * `scripts/sync-sites-shared.mjs`), и подписывают/проверяют ОДНИМ кодом —
 * расхождение формата между сторонами тут невозможно по построению.
 *
 * Чем это лучше общего токена в заголовке (как `X-Sites-Internal-Secret`
 * у вкладки «Помощник» админки, Э4):
 *  - секрет по сети не ходит — только HMAC, утечка лога/заголовка ничего
 *    не даёт;
 *  - подписаны метод, путь, тело, метка времени и id запроса — перехваченный
 *    запрос нельзя ни поменять, ни повторить: окно ±5 мин держит метка,
 *    а внутри окна — таблица использованных id на стороне sites-backend;
 *  - вызывающий (`caller`) — часть подписи: подпись одного направления не
 *    подходит к другому, даже если когда-нибудь секреты совпадут.
 *
 * Каноническая строка (UTF-8, разделитель `\n`):
 *   SITES-HMAC-V1 \n caller \n METHOD \n /path \n unixSeconds \n requestId \n sha256hex(body)
 * Заголовок подписи: `X-Sites-Signature: v1=<hex HMAC-SHA256(secret, строка)>`.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';

export const SITES_HMAC_SCHEME = 'SITES-HMAC-V1';

/** Окно метки времени — ±5 минут (то же, что у вебхука целей Э3). */
export const SITES_HMAC_WINDOW_SEC = 300;

/** Минимальная длина секрета: 32 символа (≈ 192 бита в base64). */
export const SITES_HMAC_MIN_SECRET = 32;

export const SITES_HMAC_HEADERS = {
  caller: 'x-sites-caller',
  timestamp: 'x-sites-timestamp',
  requestId: 'x-sites-request-id',
  signature: 'x-sites-signature',
} as const;

/** Вызывающий обучалки генератора — единственный на Ш1. */
export const SITES_CALLER_TUTORIAL = 'generator-tutorial';

/**
 * Э6-тер (к): обратное направление «sites-backend → генератор» — ТОЛЬКО
 * чтение шагов одобренной обучалки для черновика мемо (тот же секрет
 * `SITES_TUTORIAL_HMAC_SECRET`; вызывающий другой — подпись одного
 * направления к другому не подходит).
 */
export const SITES_CALLER_MEMO = 'sites-memo';

const REQUEST_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const CALLER_RE = /^[a-z0-9-]{3,40}$/;
const PATH_RE = /^\/[A-Za-z0-9/_.-]{0,255}$/;

export interface SignInput {
  caller: string;
  method: string;
  /** Путь без query: `/internal/sites/tutorial/host-status`. */
  path: string;
  /** Тело как оно уходит по сети; пустая строка — без тела. */
  body: string;
  unixSeconds: number;
  requestId: string;
}

export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function canonicalString(i: SignInput): string {
  return [
    SITES_HMAC_SCHEME,
    i.caller,
    i.method.toUpperCase(),
    i.path,
    String(Math.floor(i.unixSeconds)),
    i.requestId,
    sha256Hex(i.body),
  ].join('\n');
}

export function signSitesRequest(secret: string, i: SignInput): string {
  return `v1=${createHmac('sha256', secret)
    .update(canonicalString(i), 'utf8')
    .digest('hex')}`;
}

/** Заголовки подписанного запроса (имена — в нижнем регистре). */
export function sitesSignatureHeaders(
  secret: string,
  i: SignInput,
): Record<string, string> {
  return {
    [SITES_HMAC_HEADERS.caller]: i.caller,
    [SITES_HMAC_HEADERS.timestamp]: String(Math.floor(i.unixSeconds)),
    [SITES_HMAC_HEADERS.requestId]: i.requestId,
    [SITES_HMAC_HEADERS.signature]: signSitesRequest(secret, i),
  };
}

export type SitesSignatureCheck =
  | { ok: true; requestId: string; caller: string; unixSeconds: number }
  | {
      ok: false;
      reason: 'missing' | 'malformed' | 'stale' | 'mismatch' | 'caller';
    };

export interface VerifyInput {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  nowSeconds: number;
  /** Кого принимает маршрут (вызывающий — часть подписи). */
  expectedCaller: string;
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Проверка БЕЗ повтора: что id запроса ещё не встречался, решает вызывающий
 * (таблица использованных id) — здесь только чистая часть.
 */
export function verifySitesRequest(
  secret: string,
  v: VerifyInput,
): SitesSignatureCheck {
  const caller = one(v.headers[SITES_HMAC_HEADERS.caller]);
  const ts = one(v.headers[SITES_HMAC_HEADERS.timestamp]);
  const requestId = one(v.headers[SITES_HMAC_HEADERS.requestId]);
  const sig = one(v.headers[SITES_HMAC_HEADERS.signature]);
  if (!caller || !ts || !requestId || !sig)
    return { ok: false, reason: 'missing' };
  if (
    !CALLER_RE.test(caller) ||
    !/^\d{1,12}$/.test(ts) ||
    !REQUEST_ID_RE.test(requestId) ||
    !/^v1=[0-9a-f]{64}$/.test(sig) ||
    !PATH_RE.test(v.path)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (caller !== v.expectedCaller) return { ok: false, reason: 'caller' };
  const unixSeconds = Number(ts);
  if (Math.abs(v.nowSeconds - unixSeconds) > SITES_HMAC_WINDOW_SEC) {
    return { ok: false, reason: 'stale' };
  }
  const expected = createHmac('sha256', secret)
    .update(
      canonicalString({
        caller,
        method: v.method,
        path: v.path,
        body: v.body,
        unixSeconds,
        requestId,
      }),
      'utf8',
    )
    .digest();
  const got = Buffer.from(sig.slice(3), 'hex');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true, requestId, caller, unixSeconds };
}

export function isUsableSitesSecret(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim().length >= SITES_HMAC_MIN_SECRET;
}
