/**
 * id платежей: 128 бит случайности (base64url) — им подписан счёт Stars
 * (`invoice_payload` ≤ 128 байт) и он же `orderReference` WayForPay;
 * неугадываемый, чтобы чужой счёт нельзя было подобрать.
 */
import { randomBytes } from 'crypto';

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}

/** Детерминированный id списания кроном: повтор тика — тот же orderReference. */
export function chargeId(
  prefix: 'ren' | 'atu',
  accountId: string,
  anchorMs: number,
  n: number,
): string {
  return `${prefix}_${accountId}_${anchorMs}_${n}`;
}
