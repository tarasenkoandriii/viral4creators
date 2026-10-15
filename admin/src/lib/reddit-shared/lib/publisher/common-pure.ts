// СГЕНЕРИРОВАНО scripts/sync-admin-reddit-shared.mjs — не править.
// Источник: assist/src/lib/publisher/common-pure.ts. Правка — в источнике, затем
// `node scripts/sync-admin-reddit-shared.mjs`; CI сверяет копию флагом --check.

/**
 * AI Publisher — чистая часть HTTP-слоя кабинета (вынесена из
 * `common-api.ts` без изменения поведения): типы клиента `PublisherHttp`,
 * `opKey` попытки, сегмент пути, query и разбор ошибок `PUB_*`. Без React
 * и без клиента кита — её копирует Админка (`scripts/sync-admin-reddit-shared.mjs`,
 * вкладка «Reddit»); `common-api.ts` реэкспортирует всё отсюда.
 */

import { ApiError } from '../../kit/envelope';

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export interface CsvFile {
  filename: string;
  text: string;
  /** Частей склеено (курсор `X-Next-Before`, P-B2: до 5000 строк на часть). */
  parts?: number;
  /** Склейка остановлена на пределе частей — файл НЕ полный. */
  truncated?: boolean;
}

/** Предел склейки частей CSV: 20 × 5000 строк. */
export const CSV_MAX_PARTS = 20;

export interface PublisherHttp {
  /** `path` — от `/publisher/` без ведущего слеша: `products/<pid>/leads`. */
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  /** Мутация: `opKey` кладётся в тело (переданный или новый). */
  send<T = unknown>(
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
    opKey?: string
  ): Promise<T>;
  /**
   * Раскрытие ПД (контакт, заметки заявки): `POST` БЕЗ `opKey` — чтение с
   * записью в журнал доступа (Р-PUB-Z2-25, предаудит D1-02). Не `GET`:
   * барьеры CSRF веб-кабинета защищают только изменяющие методы.
   */
  reveal<T = unknown>(path: string, body: Record<string, unknown>): Promise<T>;
  /** Выгрузка списка `?format=csv` (ТЗ §8.4). */
  csv(path: string, query?: Query): Promise<CsvFile>;
  /** Текст `?format=md` (протокол eval). */
  markdown(path: string, query?: Query): Promise<CsvFile>;
}

/** Сырой GET (CSV): статус, тип, имя файла и текст. */
export type RawGet = (path: string) => Promise<{
  status: number;
  contentType: string;
  disposition: string;
  text: string;
  /** Заголовок `X-Next-Before`: курсор следующей части файла. */
  nextBefore?: string | null;
}>;

/** UUID v4 нижним регистром (`OP_KEY_RE` контракта, триггер `pub_uuid4`). */
export const OP_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newOpKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Сегмент пути: id из ответа сервера, но в URL — только безопасные символы. */
const SEG = /^[A-Za-z0-9_.:-]{1,128}$/;
export function seg(v: string): string {
  if (!SEG.test(v)) {
    throw new ApiError('PUB_VALIDATION', `bad path segment`, 400);
  }
  return v;
}

export function queryString(q?: Query): string {
  if (!q) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// ── Ошибки (§11.2) ───────────────────────────────────────────────────────

export interface PubErrorInfo {
  code: string;
  status: number;
  message: string;
  details: Record<string, unknown>;
}

export function pubError(e: unknown): PubErrorInfo | null {
  if (!(e instanceof ApiError)) return null;
  return {
    code: e.code,
    status: e.status,
    message: e.message,
    details: e.details ?? {},
  };
}

/**
 * Ключ попытки действия (§11.1): один `opKey` на попытку; `sig` — подпись
 * действия (путь+тело). Тот же `sig` после повторяемой ошибки — тот же
 * ключ (сервер вернёт прежний результат); другой `sig` — новый ключ (иначе
 * ДРУГОЕ действие ушло бы со старым ключом → 409 `PUB_IDEMPOTENCY_REUSED`).
 */
export interface OpKeyState {
  key: string;
  sig: string;
}
export function opKeyFor(
  prev: OpKeyState | null,
  sig: string,
  gen: () => string = newOpKey
): OpKeyState {
  return prev && prev.sig === sig ? prev : { key: gen(), sig };
}
/** После попытки: успех или неповторяемая ошибка — ключ сбрасывается. */
export function opKeyAfter(
  state: OpKeyState,
  error: unknown
): OpKeyState | null {
  return error !== null && error !== undefined && isRetryable(error)
    ? state
    : null;
}

/**
 * Статусы шлюза: ответа приложения не было (502/503/504 платформы, 504
 * `UPSTREAM_TIMEOUT` прокси Админки) — исход запроса неизвестен.
 */
const GATEWAY_STATUSES: readonly number[] = [502, 503, 504];

/**
 * 502/503/504 — ответ шлюза, а не приложения: исход неизвестен. Прикладной
 * код `PUB_*` (кроме `PUB_BUSY`) при этих статусах — явный ответ сервера
 * (`PUB_AI_UNAVAILABLE` — отказ модели, сохранённый под этим `opKey`;
 * `PUB_CONTACT_KEY_MISSING`, `PUB_FORM_CLOSED` — нужна настройка): повтор с
 * тем же ключом воспроизведёт тот же отказ.
 */
export function isGatewayFailure(e: ApiError): boolean {
  return (
    GATEWAY_STATUSES.includes(e.status) &&
    !(e.code.startsWith('PUB_') && e.code !== 'PUB_BUSY')
  );
}

/**
 * Повтор с тем же `opKey` безопасен: сеть, таймаут, `PUB_BUSY`, ответ шлюза
 * 502/503/504 без прикладного кода и `UPSTREAM_TIMEOUT` (Р-RD-AUD-7): если
 * сервер операцию дописал, повтор вернёт её сохранённый ответ, а не создаст
 * дубль; если нет — выполнит её (ошибка операции ключ не занимает).
 */
export function isRetryable(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    (e.code === 'network' ||
      e.code === 'PUB_BUSY' ||
      e.code === 'UPSTREAM_TIMEOUT' ||
      e.status === 0 ||
      isGatewayFailure(e))
  );
}

/** `PUB_VALIDATION.details.fields: [{field, code}]`. */
export function fieldIssues(
  e: unknown
): Array<{ field: string; code: string }> {
  const d = pubError(e)?.details;
  if (!d || !Array.isArray(d.fields)) return [];
  return d.fields
    .slice(0, 50)
    .filter(
      (x): x is { field: string; code: string } =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as { field?: unknown }).field === 'string' &&
        typeof (x as { code?: unknown }).code === 'string'
    )
    .map((x) => ({ field: x.field, code: x.code }));
}
