/**
 * Действующий тариф кабинета и текущий период учёта — чистая функция от
 * строки assist_subscriptions (или её отсутствия) и времени. Её зовут и
 * кабинет, и конвейер ответа виджета (под assist_public), и крон — одна
 * логика, одно «сейчас».
 *
 * Периоды — отрезки по `periodDays` тарифа от `anchorAt`, пока не
 * наступил `paidThrough`:
 *  - продление (Stars-автопродление, WayForPay по recToken, повторная
 *    покупка того же тарифа) сдвигает `paidThrough` на 30 дней — периоды
 *    идут дальше от того же якоря, счётчик нового периода — новая строка;
 *  - смена тарифа начинает новый якорь «сейчас» (новый период и лимит
 *    нового тарифа сразу, без перезагрузки виджета — приёмка Э4);
 *  - после `paidThrough` — льгота `GRACE_MS` для способов с продлением
 *    (Telegram/банк ещё не прислали платёж): тариф действует, но период НЕ
 *    обновляется (бесплатных единиц льгота не даёт); затем — истёк;
 *  - строки нет — пробный период от первого сайта кабинета с помощником
 *    (`trialStart` = min(assist_sites.createdAt)), нет и их — пробный ещё не начат (лимит 0, виджета без сайта нет).
 */

import { ASSIST_PLANS, isAssistPlanId, type AssistPlanId } from './plans';

const DAY = 24 * 60 * 60 * 1000;
/** Льгота после конца оплаченного: Stars/банк продлевают с задержкой. */
export const GRACE_MS = 3 * DAY;

export interface SubscriptionRow {
  planId: string;
  status: string;
  method: string;
  anchorAt: Date;
  paidThrough: Date;
  cancelAtPeriodEnd: boolean;
  autoTopUp: boolean;
  autoTopUpCapMicroUsd: bigint | number;
}

export type SubscriptionStatus =
  'trial' | 'active' | 'grace' | 'expired' | 'none';

export interface SubscriptionState {
  /** Действующий тариф; null — нет (истёк или пробный не начат). */
  planId: AssistPlanId | null;
  status: SubscriptionStatus;
  /** Чем продлевается: trial | stars | wayforpay | manual. */
  method: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Ключ строки счётчика (начало периода, ISO); null — считать нечего. */
  periodKey: string | null;
  /** До какого момента оплачено (у пробного — конец пробного). */
  paidThrough: Date | null;
  /** Будет ли продлён автоматически. */
  renews: boolean;
  cancelAtPeriodEnd: boolean;
  autoTopUp: boolean;
  autoTopUpCapMicroUsd: number;
}

const RENEWING_METHODS = new Set(['stars', 'wayforpay']);

function noPlan(method: string): SubscriptionState {
  return {
    planId: null,
    status: 'none',
    method,
    periodStart: null,
    periodEnd: null,
    periodKey: null,
    paidThrough: null,
    renews: false,
    cancelAtPeriodEnd: false,
    autoTopUp: false,
    autoTopUpCapMicroUsd: 0,
  };
}

export function subscriptionState(
  row: SubscriptionRow | null,
  trialStart: Date | null,
  now: Date,
): SubscriptionState {
  if (!row) {
    if (!trialStart) return noPlan('trial');
    const trial = ASSIST_PLANS.trial;
    const end = new Date(trialStart.getTime() + trial.periodDays * DAY);
    if (now.getTime() >= end.getTime()) {
      return { ...noPlan('trial'), status: 'expired', paidThrough: end };
    }
    return {
      planId: 'trial',
      status: 'trial',
      method: 'trial',
      periodStart: trialStart,
      periodEnd: end,
      periodKey: trialStart.toISOString(),
      paidThrough: end,
      renews: false,
      cancelAtPeriodEnd: false,
      autoTopUp: false,
      autoTopUpCapMicroUsd: 0,
    };
  }
  const planId = isAssistPlanId(row.planId) ? row.planId : null;
  if (!planId || row.status === 'expired') {
    return {
      ...noPlan(row.method),
      status: 'expired',
      paidThrough: row.paidThrough,
    };
  }
  const periodMs = ASSIST_PLANS[planId].periodDays * DAY;
  const anchor = row.anchorAt.getTime();
  const paid = row.paidThrough.getTime();
  const t = now.getTime();
  const renews = RENEWING_METHODS.has(row.method) && !row.cancelAtPeriodEnd;
  const inGrace = t >= paid && renews && t < paid + GRACE_MS;
  if (t >= paid && !inGrace) {
    return {
      ...noPlan(row.method),
      status: 'expired',
      paidThrough: row.paidThrough,
    };
  }
  // Последний оплаченный период — потолок индекса (льгота не даёт новый).
  const lastIdx = Math.max(0, Math.ceil((paid - anchor) / periodMs) - 1);
  const idx = Math.min(
    Math.max(0, Math.floor((t - anchor) / periodMs)),
    lastIdx,
  );
  const start = new Date(anchor + idx * periodMs);
  const end = new Date(Math.min(anchor + (idx + 1) * periodMs, paid));
  return {
    planId,
    status: inGrace ? 'grace' : planId === 'trial' ? 'trial' : 'active',
    method: row.method,
    periodStart: start,
    periodEnd: end,
    periodKey: start.toISOString(),
    paidThrough: row.paidThrough,
    renews,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    autoTopUp: row.autoTopUp,
    autoTopUpCapMicroUsd: Number(row.autoTopUpCapMicroUsd),
  };
}

/** Лимит единиц периода: тариф + докупка (+ авто-пакет, если разрешён). */
export function unitsLimit(
  state: Pick<SubscriptionState, 'planId'>,
  extraUnits: number,
): number {
  if (!state.planId) return 0;
  return ASSIST_PLANS[state.planId].dialogsPerMonth + Math.max(0, extraUnits);
}

/**
 * Новая подписка/продление после оплаты: что записать в строку.
 *  - тот же тариф и подписка ещё действует (или в льготе) — `paidThrough`
 *    сдвигается на период, якорь тот же (оплаченное время не теряется);
 *  - другой тариф или подписка истекла — новый якорь «сейчас».
 */
export function applyPaidPeriod(
  current: SubscriptionRow | null,
  planId: AssistPlanId,
  now: Date,
): { anchorAt: Date; paidThrough: Date; planChanged: boolean } {
  const periodMs = ASSIST_PLANS[planId].periodDays * DAY;
  if (current && current.planId === planId && current.status !== 'expired') {
    const paid = current.paidThrough.getTime();
    const renews = RENEWING_METHODS.has(current.method);
    const alive = now.getTime() < paid + (renews ? GRACE_MS : 0);
    if (alive) {
      return {
        anchorAt: current.anchorAt,
        paidThrough: new Date(paid + periodMs),
        planChanged: false,
      };
    }
  }
  return {
    anchorAt: now,
    paidThrough: new Date(now.getTime() + periodMs),
    planChanged: !current || current.planId !== planId,
  };
}
