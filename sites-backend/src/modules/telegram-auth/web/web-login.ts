/**
 * Вход в веб-кабинет данными Telegram Login Widget — чистые функции.
 *
 * Подпись проверяет `shared/telegram-login-widget.util.ts` — копия (через
 * scripts/sync-sites-shared.mjs) проверки главной админки
 * (backend/src/modules/admin-auth): ключ — SHA256(bot_token), а НЕ
 * HMAC("WebAppData", token), как у initData. Токен — `ASSIST_BOT_TOKEN`:
 * веб-кабинет принадлежит приложению помощника, его бот и стоит виджетом на
 * домене кабинета (BotFather `/setdomain`). Токен QA сюда не подставляется
 * никогда — тот же запрет перебора, что для initData.
 *
 * Тело не проходит через DTO: hash считается по ВСЕМ присланным полям, и
 * белый список DTO с `forbidNonWhitelisted` превратил бы любое новое поле
 * виджета в отказ входа. Вместо этого — строгая проверка формы здесь.
 */

import {
  TelegramLoginWidgetInvalidError,
  TelegramLoginWidgetPayload,
  validateTelegramLoginWidgetPayload,
} from '../../../shared/telegram-login-widget.util';

/**
 * Срок `auth_date` — сутки, как у главной админки (умолчание
 * `validateTelegramLoginWidgetPayload`); задан явно, чтобы смена умолчания
 * в источнике не меняла срок здесь молча.
 */
export const WIDGET_MAX_AGE_SECONDS = 86400;

const FIELD_RE = /^[a-z_]{1,32}$/;
const MAX_FIELDS = 16;
const MAX_VALUE = 512;

export class WidgetLoginRejected extends Error {
  constructor(readonly logReason: string) {
    super(logReason);
    this.name = 'WidgetLoginRejected';
  }
}

export interface WidgetUser {
  telegramId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
}

/** Форма тела: плоский объект строк/чисел, без вложенности и мусора. */
export function parseWidgetBody(body: unknown): TelegramLoginWidgetPayload {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new WidgetLoginRejected('тело не объект');
  }
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length > MAX_FIELDS) {
    throw new WidgetLoginRejected('слишком много полей');
  }
  const out: Record<string, string | number> = {};
  for (const [k, v] of entries) {
    if (!FIELD_RE.test(k))
      throw new WidgetLoginRejected(`поле «${k.slice(0, 32)}»`);
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v.length <= MAX_VALUE) out[k] = v;
    else throw new WidgetLoginRejected(`значение поля ${k}`);
  }
  const id = Number(out.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new WidgetLoginRejected('id не положительное целое');
  }
  const authDate = Number(out.auth_date);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    throw new WidgetLoginRejected('auth_date не целое');
  }
  if (typeof out.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(out.hash)) {
    throw new WidgetLoginRejected('hash не hex-64');
  }
  // Значения в data-check-string — ровно как прислал Telegram (строка или
  // число печатаются одинаково), поэтому `out` уходит в проверку как есть.
  return out as unknown as TelegramLoginWidgetPayload;
}

export function verifyWidgetLogin(body: unknown, botToken: string): WidgetUser {
  const payload = parseWidgetBody(body);
  try {
    validateTelegramLoginWidgetPayload(payload, {
      botToken,
      maxAgeSeconds: WIDGET_MAX_AGE_SECONDS,
    });
  } catch (err) {
    if (err instanceof TelegramLoginWidgetInvalidError) {
      throw new WidgetLoginRejected(err.message);
    }
    throw err;
  }
  const str = (v: unknown) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, 128) : null;
  return {
    telegramId: BigInt(Number(payload.id)),
    username: str(payload.username),
    firstName: str(payload.first_name),
    lastName: str(payload.last_name),
    photoUrl: str(payload.photo_url),
  };
}

/**
 * Простой лимит попыток входа: фиксированное окно в памяти инстанса.
 *
 * Чего он НЕ делает (и почему этого достаточно для Э0): на Vercel
 * инстансов несколько и они живут недолго, так что реальный потолок —
 * «limit на инстанс». Подобрать подпись перебором нельзя в принципе
 * (HMAC-SHA256), лимит защищает базу от залпа INSERT-ов сессий
 * повторами одного валидного payload (он живёт сутки). Общий лимит по
 * ipHash в базе (как backend `rate_limits`) — когда sites-backend
 * заведёт свой rate-limit (контракт Э0, п.3: нечистые модули — свои).
 */
export class LoginRateLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(
    readonly limit = 10,
    readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
  ) {}

  /** `null` — можно; число — сколько мс ждать. */
  hit(key: string, now = Date.now()): number | null {
    const cur = this.hits.get(key);
    if (!cur || now - cur.start >= this.windowMs) {
      if (this.hits.size >= this.maxKeys) this.prune(now);
      this.hits.set(key, { start: now, count: 1 });
      return null;
    }
    cur.count += 1;
    if (cur.count > this.limit) return cur.start + this.windowMs - now;
    return null;
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) {
      if (now - v.start >= this.windowMs) this.hits.delete(k);
    }
    // Залп с уникальных адресов: память важнее точности — сброс целиком.
    if (this.hits.size >= this.maxKeys) this.hits.clear();
  }
}
