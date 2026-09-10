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

export function signStarsInvoicePayload(
  input: Omit<StarsInvoicePayload, 'expiresAt'>,
  rawKey: string | undefined,
): string {
  const key = resolveKey(rawKey);
  const payload: StarsInvoicePayload = {
    ...input,
    expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  const sig = hmac(payloadB64, key);
  return `${payloadB64}.${sig}`;
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
  const [payloadB64, sig] = parts;
  const expected = hmac(payloadB64, key);
  if (!safeEqual(sig, expected)) return null;
  let payload: StarsInvoicePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof payload.userId !== 'string' ||
    (payload.purpose !== 'SUBSCRIPTION' && payload.purpose !== 'CREDIT_PACK') ||
    typeof payload.target !== 'string' ||
    typeof payload.expiresAt !== 'number'
  ) {
    return null;
  }
  if (!opts.skipExpiry && payload.expiresAt < Math.floor(Date.now() / 1000)) {
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
