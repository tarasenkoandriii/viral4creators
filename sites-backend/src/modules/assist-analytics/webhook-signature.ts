/**
 * Подпись вебхука целей s2s — A (ТЗ §5-тер.1 «Вебхук s2s», §5-тер.16 п.4).
 * ЧИСТЫЙ модуль. Заголовок `GOAL_WEBHOOK_SIGNATURE_HEADER` (brand.ts):
 * `t=<unix секунды>,v1=<hex HMAC-SHA256(secret, "<t>.<сырое тело>")>`;
 * окно ±5 мин (защита от повтора); сравнение — timingSafeEqual.
 * Те же векторы проверяет плагин WordPress (PHP) и npm-пакет:
 * `assist-integrations/fixtures/goal-webhook-vectors.json` — общий файл
 * (T пишет, A читает в спеке; расхождение = плагин шлёт подпись, которую
 * сервер отвергает).
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { ANALYTICS_DEFAULTS } from '../../config/assist-defaults';

export const SIGNATURE_WINDOW_SEC =
  ANALYTICS_DEFAULTS.webhookSignatureWindowSec;

export function signGoalWebhook(
  secret: string,
  rawBody: string,
  unixSec: number,
): string {
  const t = Math.floor(unixSec);
  const v1 = createHmac('sha256', secret)
    .update(`${t}.${rawBody}`, 'utf8')
    .digest('hex');
  return `t=${t},v1=${v1}`;
}

export type SignatureCheck =
  'ok' | 'missing' | 'malformed' | 'stale' | 'mismatch';

export function verifyGoalWebhook(
  secret: string,
  rawBody: string,
  header: string | undefined,
  nowSec: number,
): SignatureCheck {
  if (!header || !header.trim()) return 'missing';
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) return 'malformed';
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') {
      if (!/^\d{1,12}$/.test(v) || t !== null) return 'malformed';
      t = Number(v);
    } else if (k === 'v1') {
      if (!/^[0-9a-f]{64}$/.test(v)) return 'malformed';
      sigs.push(v);
    }
    // Прочие схемы (v0, v2…) — будущие версии подписи, игнорируются.
  }
  if (t === null || !sigs.length) return 'malformed';
  if (Math.abs(nowSec - t) > SIGNATURE_WINDOW_SEC) return 'stale';
  const expected = createHmac('sha256', secret)
    .update(`${t}.${rawBody}`, 'utf8')
    .digest();
  const ok = sigs.some((s) => timingSafeEqual(Buffer.from(s, 'hex'), expected));
  return ok ? 'ok' : 'mismatch';
}
