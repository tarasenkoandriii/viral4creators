/**
 * Счёт диалогов в единицах (ТЗ помощника §7.1, Р-58; приёмка Э4 «диалог
 * считается по правилам — юнит-тесты»). Чистые функции.
 *
 *  - Диалог = сессия посетителя с ≥ 1 ответом модели; закрывается через
 *    30 минут тишины — следующий вопрос открывает НОВЫЙ диалог.
 *  - > 30 ответов — диалог за 2, > 60 — за 3 («бесконечный диалог»).
 *  - Вес вида: текст «Сайта» — 1; голос (распознавание или озвучка хотя бы
 *    одного ответа) или голосовое управление — 2; озвучка Resemble — 3;
 *    «Админка» — 3; pro-модель — ⌈себестоимость / $0.04⌉.
 * Счётчик занимает единицы ПРИРАЩЕНИЕМ: первый ответ — вес, 31-й и 61-й —
 * ещё по весу (в сумме за диалог — вес × множитель).
 */

import { UNIT_COST_MICRO_USD } from './plans';

/** 30 минут тишины (§7.1). */
export const DIALOG_IDLE_MS = 30 * 60 * 1000;
/** Пороги множителя: > 30 ответов — ×2, > 60 — ×3. */
export const DIALOG_WEIGHT_STEPS = [30, 60] as const;

export type DialogKind = 'text' | 'voice' | 'voice-premium' | 'admin';

export const DIALOG_BASE_UNITS: Readonly<Record<DialogKind, number>> = {
  text: 1,
  voice: 2,
  'voice-premium': 3,
  admin: 3,
};

/** Публичные веса (лендинг: «голосовой диалог — 2, „Админка“ — 3»). */
export const PUBLIC_DIALOG_WEIGHTS = {
  text: DIALOG_BASE_UNITS.text,
  voice: DIALOG_BASE_UNITS.voice,
  admin: DIALOG_BASE_UNITS.admin,
} as const;

/** Вес по фактической себестоимости (эскалация на pro-модель). */
export function unitsForCost(costMicroUsd: number): number {
  if (!(costMicroUsd > 0)) return 1;
  return Math.max(1, Math.ceil(costMicroUsd / UNIT_COST_MICRO_USD));
}

/** Множитель «бесконечного диалога» после `answers` ответов модели. */
export function dialogMultiplier(answers: number): number {
  let m = 1;
  for (const step of DIALOG_WEIGHT_STEPS) if (answers > step) m += 1;
  return m;
}

/** Сколько единиц стоит диалог целиком после `answers` ответов. */
export function dialogUnits(baseUnits: number, answers: number): number {
  if (!(answers > 0)) return 0;
  return Math.max(1, Math.floor(baseUnits)) * dialogMultiplier(answers);
}

/**
 * Сколько единиц занять на `answers`-м ответе модели. `firstCounted` —
 * ответ, которым диалог впервые засчитывается (после открытия или после
 * 30 минут тишины): занимается всё, что диалог стоит к этому ответу.
 */
export function unitsDelta(
  baseUnits: number,
  answers: number,
  firstCounted: boolean,
): number {
  const now = dialogUnits(baseUnits, answers);
  if (firstCounted) return now;
  return Math.max(0, now - dialogUnits(baseUnits, answers - 1));
}

/** Тот же диалог или новый: тишина дольше 30 минут — новый (§7.1). */
export function isNewDialog(lastMessageAt: Date | null, now: Date): boolean {
  if (!lastMessageAt) return true;
  return now.getTime() - lastMessageAt.getTime() > DIALOG_IDLE_MS;
}
