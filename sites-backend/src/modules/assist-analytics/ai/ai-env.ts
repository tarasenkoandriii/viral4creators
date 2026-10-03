/**
 * Окружение аналитики с ИИ (Э3-бис; doc/DEPLOYMENT.md §6.21) — ЧИСТЫЙ модуль.
 *
 *  - `ASSIST_LITE_MODEL` — модель разметки и выводов (самая дешёвая
 *    lite-модель Gemini, §4.5, §5-тер.3). Не задана или без ставки в
 *    `shared/ai-pricing.ts` (unpriced) — разметка и выводы моделью НЕ
 *    запускаются («без неё разметка не запускается»; без ставки потолок денег
 *    не держится). Находки кодом и сухие строки работают всегда.
 *  - `ASSIST_ANALYTICS_PLATFORM_DAILY_USD` — суточный потолок платформы на
 *    `assist-label` + `assist-insight` по всем кабинетам (умолчание $5):
 *    ловит сбой (цикл повторов, утечку ключа), а не честный рост.
 *  - `ASSIST_ANALYTICS_REF_SECRET` — подпись `V4CAssist('ref')` (иначе —
 *    производный от `ASSIST_SECRETS_KEY`).
 */
import { createHash } from 'crypto';
import { estimateCost, rateFor } from '../../../shared/ai-pricing';

export const DEFAULT_PLATFORM_DAILY_USD = 5;

export type AnalyticsModel =
  { ok: true; model: string } | { ok: false; reason: 'unset' | 'unpriced' };

export function analyticsModel(
  env: NodeJS.ProcessEnv = process.env,
): AnalyticsModel {
  const model = (env.ASSIST_LITE_MODEL ?? '').trim();
  if (!model) return { ok: false, reason: 'unset' };
  if (!rateFor(model, env)) return { ok: false, reason: 'unpriced' };
  // Ставка есть, но нулевая (мусор в AI_PRICE_*) — тоже «не держим потолок».
  const probe = estimateCost(model, { inputTokens: 1_000_000 }, env);
  if (probe.unpriced || probe.costMicroUsd <= 0) {
    return { ok: false, reason: 'unpriced' };
  }
  return { ok: true, model };
}

export function platformDailyCapMicroUsd(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.ASSIST_ANALYTICS_PLATFORM_DAILY_USD;
  const v = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  const usd = Number.isFinite(v) && v >= 0 ? v : DEFAULT_PLATFORM_DAILY_USD;
  return Math.round(usd * 1_000_000);
}

/** Секрет подписи ref (§5-тер.1 «assistRef»): свой или производный. */
export function refSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const own = (env.ASSIST_ANALYTICS_REF_SECRET ?? '').trim();
  if (own.length >= 16) return own;
  const base = (env.ASSIST_SECRETS_KEY ?? '').trim();
  if (!base) return null;
  return createHash('sha256').update(`assist-ref:${base}`).digest('hex');
}
