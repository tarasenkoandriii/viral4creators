/**
 * Подписанный `payload` для инвойса Telegram Stars (этап 62, ТЗ §41.2).
 *
 * Telegram передаёт `payload` инвойса обратно нетронутым в
 * `pre_checkout_query`/`successful_payment` — это единственное поле в
 * протоколе, которое мы полностью контролируем и которое доживает от
 * старта покупки до вебхука. Кладём туда, что покупали и для кого, подписав
 * HMAC — тот же приём, что `oauth-state.util.ts` для OAuth `state` (этап
 * 61): подделать нельзя, даже зная формат, и не нужно отдельной таблицы
 * «незавершённые чекауты» — вся нужная информация едет в самом payload.
 */

import { createHmac, timingSafeEqual } from 'crypto';

export interface StarsInvoicePayload {
  userId: string;
  purpose: 'SUBSCRIPTION' | 'CREDIT_PACK';
  /** UserPlan для SUBSCRIPTION, id пакета для CREDIT_PACK. */
  target: string;
  /** Unix-секунды истечения — инвойс-ссылка одноразовая по факту. */
  expiresAt: number;
}

const TTL_SECONDS = 30 * 60;

/**
 * Лимит Bot API на `payload` инвойса (`sendInvoice`/`createInvoiceLink`):
 * «Bot-defined invoice payload, 1-128 bytes». Аудит Э4 (2026-10-02):
 * прежний формат `base64url(JSON).hmac` весил ~184 байта для cuid
 * пользователя — Telegram отклонял `createInvoiceLink`, Stars-оплата
 * генератора не стартовала вовсе.
 */
export const STARS_INVOICE_PAYLOAD_MAX_BYTES = 128;

/** Компактный формат v2: `v2:<S|C>:<target>:<userId>:<expiresAt36>.<hmac>`.
 * Без base64 и JSON-ключей: ~90 байт для cuid, ~100 для uuid. HMAC —
 * тот же SHA-256 на том же ключе, по всему телу до точки (вместе с
 * префиксом версии), полная длина. */
const V2_PREFIX = 'v2';
const PURPOSE_CODE: Record<StarsInvoicePayload['purpose'], string> = {
  SUBSCRIPTION: 'S',
  CREDIT_PACK: 'C',
};
const SAFE_FIELD = /^[A-Za-z0-9_-]+$/;

export function signStarsInvoicePayload(
  input: Omit<StarsInvoicePayload, 'expiresAt'>,
  rawKey: string | undefined,
): string {
  const key = resolveKey(rawKey);
  if (!SAFE_FIELD.test(input.userId) || !SAFE_FIELD.test(input.target)) {
    throw new Error(
      `Stars payload: userId/target вне [A-Za-z0-9_-] — ${input.userId}/${input.target}`,
    );
  }
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const body = [
    V2_PREFIX,
    PURPOSE_CODE[input.purpose],
    input.target,
    input.userId,
    expiresAt.toString(36),
  ].join(':');
  const raw = `${body}.${hmac(body, key)}`;
  if (Buffer.byteLength(raw, 'utf8') > STARS_INVOICE_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `Stars payload ${Buffer.byteLength(raw, 'utf8')} байт > лимита Bot API ${STARS_INVOICE_PAYLOAD_MAX_BYTES}`,
    );
  }
  return raw;
}

/** Возвращает `null`, а не бросает — вызывающий (webhook.controller)
 * отвечает Telegram понятным отказом (`ok:false` на pre_checkout_query),
 * не 500.
 *
 * `skipExpiry` (аудит round4, Г-2.1) — для автопродления подписки
 * Telegram присылает `successful_payment` с ТЕМ ЖЕ `invoice_payload`, что
 * и у самого первого платежа (`is_recurring: true`, без
 * `pre_checkout_query`), в том числе через месяцы после того, как
 * `expiresAt` (30 минут, рассчитан на одноразовую ссылку чекаута) истёк.
 * Без этого флага каждое автопродление отклонялось бы как «просроченная
 * ссылка» — Stars списаны, подписка не продлена. HMAC при этом
 * проверяется как обычно: подделать `payload` по-прежнему нельзя, меняем
 * только то, что «протухшая» подпись recurring-платежа остаётся
 * действительной. */
export function verifyStarsInvoicePayload(
  raw: string | undefined,
  rawKey: string | undefined,
  opts: { skipExpiry?: boolean } = {},
): StarsInvoicePayload | null {
  if (!raw) return null;
  const key = resolveKey(rawKey);
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = hmac(body, key);
  if (!safeEqual(sig, expected)) return null;
  const payload = body.startsWith(`${V2_PREFIX}:`)
    ? parseV2(body)
    : parseLegacy(body);
  if (!payload) return null;
  if (!opts.skipExpiry && payload.expiresAt < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

function parseV2(body: string): StarsInvoicePayload | null {
  const f = body.split(':');
  if (f.length !== 5) return null;
  const [, code, target, userId, exp36] = f;
  const purpose =
    code === PURPOSE_CODE.SUBSCRIPTION
      ? 'SUBSCRIPTION'
      : code === PURPOSE_CODE.CREDIT_PACK
        ? 'CREDIT_PACK'
        : null;
  const expiresAt = parseInt(exp36, 36);
  if (!purpose || !target || !userId || !Number.isFinite(expiresAt)) {
    return null;
  }
  return { userId, purpose, target, expiresAt };
}

/** Прежний формат `base64url(JSON)` — только проверка (подпись тем же
 * ключом), новые инвойсы его не выпускают. */
function parseLegacy(payloadB64: string): StarsInvoicePayload | null {
  let payload: StarsInvoicePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.userId !== 'string' ||
    (payload.purpose !== 'SUBSCRIPTION' && payload.purpose !== 'CREDIT_PACK') ||
    typeof payload.target !== 'string' ||
    typeof payload.expiresAt !== 'number'
  ) {
    return null;
  }
  return payload;
}

function resolveKey(rawKey: string | undefined): string {
  const key = rawKey?.trim();
  if (!key) {
    throw new Error(
      'PAYMENT_TOKEN_KEY не задан — оплата через Stars недоступна',
    );
  }
  return key;
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
