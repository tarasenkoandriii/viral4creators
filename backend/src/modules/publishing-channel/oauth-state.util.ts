/**
 * Подписанный `state` для OAuth-подключения канала (этап 61, ТЗ §14.4).
 *
 * Кнопка «Подключить канал» в TMA не может быть простой ссылкой: личность
 * в проекте передаётся заголовками на КАЖДЫЙ запрос (`X-Telegram-Init-
 * Data`/`X-Dev-User-Id`), а не cookie-сессией — обычная навигация браузера
 * их не понесёт. Поэтому старт (`POST /channels/oauth/:platform/start`,
 * под TelegramIdentityGuard) кладёт userId В САМ `state`, подписанный
 * HMAC — а колбэк (`GET /channels/oauth/:platform/callback`, ПУБЛИЧНЫЙ:
 * его дёргает сам Google/TikTok) достаёт userId оттуда же, без каких-либо
 * наших заголовков.
 *
 * Тот же принцип constant-time сравнения, что в cron-secret.ts —
 * подделать state нельзя, даже зная его формат.
 */

import { createHmac, timingSafeEqual } from 'crypto';

export interface OAuthState {
  userId: string;
  platform: string;
  /** Unix-секунды истечения — короткое окно, ссылка одноразовая по факту. */
  expiresAt: number;
}

const TTL_SECONDS = 10 * 60;

/** `<payload-base64url>.<hmac-base64url>` — один параметр в URL. */
export function signOAuthState(
  userId: string,
  platform: string,
  rawKey: string | undefined,
): string {
  const key = resolveKey(rawKey);
  const payload: OAuthState = {
    userId,
    platform,
    expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  const sig = hmac(payloadB64, key);
  return `${payloadB64}.${sig}`;
}

/** Возвращает `null` вместо того, чтобы бросать — колбэк без валидного
 * state должен показать понятную страницу «ссылка устарела», не 500. */
export function verifyOAuthState(
  state: string | undefined,
  rawKey: string | undefined,
): OAuthState | null {
  if (!state) return null;
  const key = resolveKey(rawKey);
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = hmac(payloadB64, key);
  if (!safeEqual(sig, expected)) return null;
  let payload: OAuthState;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof payload.userId !== 'string' ||
    typeof payload.platform !== 'string' ||
    typeof payload.expiresAt !== 'number'
  ) {
    return null;
  }
  if (payload.expiresAt < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function resolveKey(rawKey: string | undefined): string {
  const key = rawKey?.trim();
  if (!key) {
    throw new Error(
      'CHANNEL_TOKEN_KEY не задан — подключение каналов выгрузки недоступно',
    );
  }
  return key;
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function hmac(data: string, key: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
