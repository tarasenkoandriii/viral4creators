/**
 * Оплата (ТЗ §41, этап 62) — тонкие функции над общим `api` (services/api.ts),
 * тем же приёмом, что projects-api.ts: тот же interceptor идентичности, тот
 * же конверт ответа.
 *
 * `GET /billing/prices` — публичный маршрут, работает и анонимно (цены не
 * секрет); оба `checkout`-маршрута требуют identity (см.
 * `TelegramIdentityGuard` на бэкенде) — анонимный путь ловит 401, экран
 * показывает `isUnauthorized()`.
 */

import { api } from './api';
import { getPlanState } from './projects-api';
import type {
  BillingPrices,
  CheckoutResult,
  PaymentMethod,
  PlanId,
  PlanState,
} from '../types';

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

export async function getBillingPrices(): Promise<BillingPrices> {
  return unwrap(
    await api.get<BillingPrices>('/billing/prices'),
    'billing prices'
  );
}

export async function startSubscriptionCheckout(
  plan: Extract<PlanId, 'STANDARD' | 'PREMIUM'>,
  method: PaymentMethod
): Promise<CheckoutResult> {
  return unwrap(
    await api.post<CheckoutResult>('/billing/checkout/subscription', {
      plan,
      method,
    }),
    'subscription checkout'
  );
}

export async function startCreditPackCheckout(
  packId: string,
  method: PaymentMethod
): Promise<CheckoutResult> {
  return unwrap(
    await api.post<CheckoutResult>('/billing/checkout/credit-pack', {
      packId,
      method,
    }),
    'credit pack checkout'
  );
}

/**
 * Редирект на форму покупки WayForPay — обязательно `<form method="POST">`,
 * а не `window.location.href` (комментарий `WayForPayService.
 * buildPurchaseForm` на бэкенде): в отличие от OAuth-редиректа этапа 61,
 * здесь нужно унести с собой подписанные поля (`merchantSignature` и
 * остальные), а не только URL. Форма создаётся, отправляется и тут же
 * убирается из DOM — страница уже уходит на WayForPay, чистить незачем,
 * но оставлять мусорный узел в DOM на случай отмены браузером не стоит.
 */
export function submitWayForPayForm(
  url: string,
  fields: Record<string, string>
): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = url;
  form.style.display = 'none';
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

/**
 * Опрос `/me/plan` после оплаты с бэкоффом (решение 17 плана этапа 62):
 * вебхук провайдера может прийти на секунду-другую позже, чем колбэк
 * `openInvoice()` у Stars или сам возврат с WayForPay — один немедленный
 * запрос слишком часто застаёт ещё не применённую покупку. Останавливается,
 * как только `until` подтвердит применение, либо после последней попытки —
 * вызывающий экран сам решает, что показать по итоговому состоянию.
 */
export async function pollPlanState(
  until: (state: PlanState) => boolean,
  attempts = 6,
  delayMs = 1500
): Promise<PlanState> {
  let state = await getPlanState();
  for (let i = 0; i < attempts && !until(state); i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    state = await getPlanState();
  }
  return state;
}
