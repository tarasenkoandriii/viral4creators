/**
 * Подписи WayForPay (HMAC-MD5 секретом мерчанта) — ЧИСТЫЙ модуль: поля и
 * порядок конкатенации из `billing/wayforpay.service.ts` (этап 62, сверены
 * с wiki.wayforpay.com 2026-09-08), вынесены без изменения поведения, чтобы
 * бэкенд клиентских сайтов (оплата ИИ-помощника, Э4) подписывал и проверял
 * ровно так же. Копия — `sites-backend/src/shared/wayforpay-signature.ts`
 * через `scripts/sync-sites-shared.mjs` (CI сверяет `--check`).
 *
 * Секрет — параметром: генератор и sites-backend держат свои env.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Поля, по которым подписывается форма покупки и host2host `Charge`. */
export interface WayForPayPurchaseSignatureFields {
  merchantAccount: string;
  merchantDomainName: string;
  orderReference: string;
  orderDate: number | string;
  /** В ОСНОВНЫХ единицах валюты — formatWayForPayAmount. */
  amount: number;
  currency: string;
  productName: string;
}

/** Поля входящего вебхука (`serviceUrl`) — из ТЕЛА запроса WayForPay. */
export interface WayForPayCallbackSignatureFields {
  merchantAccount: string;
  orderReference: string;
  amount: number | string;
  currency: string;
  authCode?: string;
  cardPan?: string;
  transactionStatus: string;
  reasonCode: number | string;
}

export function wayforpayHmac(data: string, secret: string): string {
  return createHmac('md5', secret).update(data, 'utf8').digest('hex');
}

/**
 * Сумма в ОСНОВНЫХ единицах с точкой, без хвостовых нулей сверх
 * необходимого (документированный пример — "0.13").
 */
export function formatWayForPayAmount(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}

/** Подпись формы покупки (Purchase) и host2host `Charge` — один и тот же набор. */
export function wayforpayPurchaseSignature(
  f: WayForPayPurchaseSignatureFields,
  secret: string,
): string {
  return wayforpayHmac(
    [
      f.merchantAccount,
      f.merchantDomainName,
      f.orderReference,
      String(f.orderDate),
      formatWayForPayAmount(f.amount),
      f.currency,
      f.productName,
      '1',
      formatWayForPayAmount(f.amount),
    ].join(';'),
    secret,
  );
}

export function wayforpayCallbackSignature(
  f: WayForPayCallbackSignatureFields,
  secret: string,
): string {
  return wayforpayHmac(
    [
      f.merchantAccount,
      f.orderReference,
      String(f.amount),
      f.currency,
      f.authCode ?? '',
      f.cardPan ?? '',
      f.transactionStatus,
      String(f.reasonCode),
    ].join(';'),
    secret,
  );
}

/** Сверка подписи вебхука постоянного времени (Е-1.6 шестого аудита). */
export function verifyWayForPayCallback(
  body: WayForPayCallbackSignatureFields & { merchantSignature: string },
  secret: string,
): boolean {
  return safeEqualString(
    wayforpayCallbackSignature(body, secret),
    typeof body.merchantSignature === 'string' ? body.merchantSignature : '',
  );
}

/** Подпись квитанции `accept`, без которой WayForPay повторяет доставку. */
export function wayforpayAckSignature(
  orderReference: string,
  time: number,
  secret: string,
): string {
  return wayforpayHmac(
    [orderReference, 'accept', String(time)].join(';'),
    secret,
  );
}

/**
 * Сравнение постоянного времени. `timingSafeEqual` требует буферы одной
 * длины; при разной длине сверяем буфер сам с собой — ветка не короче
 * штатной и не выдаёт длину ожидаемой подписи.
 */
export function safeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
