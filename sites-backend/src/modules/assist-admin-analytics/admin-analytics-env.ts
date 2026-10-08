/**
 * Окружение и деньги аналитики «Админки» (заход 10, №57) — ЧИСТЫЙ модуль.
 *
 *  - `ASSIST_LITE_MODEL` — та же lite-модель, что у разметки «Сайта»
 *    (doc/DEPLOYMENT.md §6.21; новых env нет). Не задана или без ставки в
 *    `shared/ai-pricing.ts` — разметка и выводы моделью НЕ запускаются (без
 *    ставки потолок денег не держится); свёртки, находки кодом, отчёт и
 *    экспорт работают всегда. Своя копия проверки, а не импорт из
 *    `assist-analytics`: правило графа «Админка» ↛ «Сайт».
 *  - Деньги — суточный потолок «Админки» сайта (тот же резерв, что у хода
 *    сотрудника, `reserveAdminTurn`), но разметке и выводам достаётся не
 *    больше `ADMIN_ANALYTICS_CAP_SHARE` потолка: остальное — ответам
 *    сотрудникам (аналитика не должна съесть рабочий день).
 */
import { estimateCost, rateFor } from '../../shared/ai-pricing';
import type { SiteAiOperation } from '../site-ai/operations';

/** Операции `site_ai_usage` аналитики «Админки» (признак режима — имя). */
export const ADMIN_LABEL_OPERATION =
  'assist-admin-label' satisfies SiteAiOperation;
export const ADMIN_INSIGHT_OPERATION =
  'assist-admin-insight' satisfies SiteAiOperation;

/** Доля суточного потолка «Админки», доступная разметке и выводам. */
export const ADMIN_ANALYTICS_CAP_SHARE = 0.5;

export type AdminLiteModel =
  { ok: true; model: string } | { ok: false; reason: 'unset' | 'unpriced' };

export function adminLiteModel(
  env: NodeJS.ProcessEnv = process.env,
): AdminLiteModel {
  const model = (env.ASSIST_LITE_MODEL ?? '').trim();
  if (!model) return { ok: false, reason: 'unset' };
  if (!rateFor(model, env)) return { ok: false, reason: 'unpriced' };
  const probe = estimateCost(model, { inputTokens: 1_000_000 }, env);
  if (probe.unpriced || probe.costMicroUsd <= 0) {
    return { ok: false, reason: 'unpriced' };
  }
  return { ok: true, model };
}

/** Оценка разметки одного диалога СВЕРХУ (12 реплик × 600 симв. + схема). */
export function adminLabelEstimateMicroUsd(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const c = estimateCost(
    model,
    { inputTokens: 4_000, outputTokens: 600 },
    env,
  ).costMicroUsd;
  return Math.max(1, Math.ceil(c));
}

/** Оценка вызова выводов недели СВЕРХУ (находки JSON-ом, 3 языка ответа). */
export function adminInsightEstimateMicroUsd(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const c = estimateCost(
    model,
    { inputTokens: 6_000, outputTokens: 3_000 },
    env,
  ).costMicroUsd;
  return Math.max(1, Math.ceil(c));
}

/** Часть потолка сайта для аналитики (целые микродоллары). */
export function adminAnalyticsCap(siteCapMicroUsd: number): number {
  return Math.max(0, Math.floor(siteCapMicroUsd * ADMIN_ANALYTICS_CAP_SHARE));
}
