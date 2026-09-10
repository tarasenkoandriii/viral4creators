/**
 * Режимы сервиса на стороне интерфейса (ТЗ §23).
 *
 * Матрица возможностей НЕ дублируется здесь: она приходит с сервера
 * (`GET /me/plan`), потому что копия быстро разошлась бы с оригиналом, а
 * расходятся такие копии всегда в худшую сторону — пользователю
 * показывают кнопку, которую сервер потом запрещает.
 *
 * Здесь только то, что нужно самому интерфейсу: как назвать замок и
 * какой режим просить.
 */

import type { PlanFeature, PlanId, PlanState } from '../types';

export const PLAN_ORDER: PlanId[] = ['LITE', 'STANDARD', 'PREMIUM'];

/** Анонимный путь (без входа) работает в Lite — сервер считает так же. */
export const ANONYMOUS_PLAN: PlanId = 'LITE';

export function allows(state: PlanState | null, feature: PlanFeature): boolean {
  if (!state) return false;
  return state.plans[state.plan]?.features[feature] ?? false;
}

/** Минимальный режим, где возможность есть — для подписи «доступно в …». */
export function minimalPlanFor(
  state: PlanState | null,
  feature: PlanFeature
): PlanId | null {
  if (!state) return null;
  return PLAN_ORDER.find((id) => state.plans[id]?.features[feature]) ?? null;
}

export function planTitle(state: PlanState | null, id: PlanId | null): string {
  if (!id) return '';
  return state?.plans[id]?.title ?? id;
}

/**
 * Подпись замка: «Доступно в Standard». Переведённые шаблоны приходят от
 * вызывающего (`dict.common` — этап 56), а не жёстко зашиты здесь: эта
 * функция — чистая логика (что минимально нужно), не текст интерфейса.
 */
export function lockLabel(
  state: PlanState | null,
  feature: PlanFeature,
  t: { availableIn: string; unavailable: string }
): string {
  const need = minimalPlanFor(state, feature);
  return need
    ? t.availableIn.replace('{{plan}}', planTitle(state, need))
    : t.unavailable;
}

/** Разрешён ли формат кадра: пустой список у режима = любые. */
export function allowsAspectRatio(
  state: PlanState | null,
  ratio: string
): boolean {
  if (!state) return false;
  const allowed = state.plans[state.plan]?.aspectRatios ?? [];
  return allowed.length === 0 || allowed.includes(ratio);
}
