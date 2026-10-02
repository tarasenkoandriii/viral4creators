/**
 * Лимиты тарифа для системного кода (обход, бюджет обучения) — места, где
 * до Э4 читались умолчания `config/assist-defaults.ts` («Trial/Start до
 * Э4»). Тариф — по кабинету (подписке, Р-58), чтение — сырым SQL основной
 * ролью (`SitesDb.system`) теми же функциями, что и в виджете.
 *
 * Нет действующего тарифа (пробный истёк, подписка не продлена): денег на
 * обучение нет (0 — плановые прогоны откладываются, ворота, исключения и
 * удаление работают всегда, §4-тер.11), обход — в пределах пробного
 * (знания не пропадают, но и не растут).
 */

import { ASSIST_PLANS } from './plans';
import { readState, type RawDb } from './public/entitlements';
import type { SubscriptionState } from './subscription-state';

export function learningBudgetFor(
  state: Pick<SubscriptionState, 'planId'>,
): number {
  return state.planId ? ASSIST_PLANS[state.planId].learningBudgetMicroUsd : 0;
}

export function crawlMaxPagesFor(
  state: Pick<SubscriptionState, 'planId'>,
): number {
  return ASSIST_PLANS[state.planId ?? 'trial'].knowledgePages;
}

export async function learningBudgetCap(
  db: RawDb,
  accountId: string,
  now: Date,
): Promise<number> {
  return learningBudgetFor(await readState(db, accountId, now));
}

export async function crawlMaxPages(
  db: RawDb,
  accountId: string,
  now: Date,
): Promise<number> {
  return crawlMaxPagesFor(await readState(db, accountId, now));
}
