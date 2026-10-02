/**
 * Клиенты платёжных провайдеров Помощника — тонкие, без SDK (как у
 * генератора: `billing/telegram-stars.service.ts`, `billing/wayforpay.service.ts`),
 * но с токеном и мерчантом ПАРАМЕТРАМИ (ТЗ §4.1: Stars выставляет бот
 * Помощника; аудит 01.10 — «billing/Stars с токеном-параметром»), сеть —
 * через подменяемый `fetch` (тесты — только моки провайдеров).
 *
 * Подписи WayForPay — общий чистый модуль `shared/wayforpay-signature.ts`
 * (копия `backend/src/common/wayforpay-signature.ts`).
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  formatWayForPayAmount,
  wayforpayPurchaseSignature,
} from '../../shared/wayforpay-signature';
import type { WayForPayConfig } from './billing-env';

export type FetchJson = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const TELEGRAM_API = 'https://api.telegram.org';
const WAYFORPAY_PURCHASE_URL = 'https://secure.wayforpay.com/pay';
const WAYFORPAY_API_URL = 'https://api.wayforpay.com/api';
/** 30 дней — шаг подписки Stars в Bot API (`subscription_period`). */
export const STARS_SUBSCRIPTION_PERIOD_SECONDS = 30 * 24 * 60 * 60;
const TIMEOUT_MS = 15_000;
/** Исход host2host `Charge` не известен (нет `transactionStatus` в ответе). */
export const CHARGE_STATUS_UNKNOWN = 'Unknown';

export interface StarsInvoiceInput {
  title: string;
  description: string;
  /** id строки assist_payments (≤ 128 байт — ограничение Bot API). */
  payload: string;
  /** Целые Stars. */
  amount: number;
  subscription: boolean;
}

export interface ChargeResult {
  ok: boolean;
  transactionStatus: string;
  reasonCode: number;
  recToken: string | null;
  rawPayload: unknown;
}

export interface PurchaseForm {
  url: string;
  fields: Record<string, string>;
}

@Injectable()
export class AssistPaymentProviders {
  private readonly logger = new Logger(AssistPaymentProviders.name);
  /** Тесты подменяют сеть. */
  fetchImpl: FetchJson = (url, init) =>
    fetch(url, init) as unknown as ReturnType<FetchJson>;

  private async post(url: string, body: unknown): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const res = await Promise.race([
        this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS);
        }),
      ]);
      return await res.json().catch(() => null);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── Telegram Stars (бот Помощника) ──────────────────────────────────

  async createStarsInvoiceLink(
    token: string,
    input: StarsInvoiceInput,
  ): Promise<string> {
    const j = (await this.post(
      `${TELEGRAM_API}/bot${token}/createInvoiceLink`,
      {
        title: input.title.slice(0, 32),
        description: input.description.slice(0, 255),
        payload: input.payload,
        // Пусто: у Stars нет внешнего провайдера (сам Telegram).
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: input.title.slice(0, 32), amount: input.amount }],
        ...(input.subscription
          ? { subscription_period: STARS_SUBSCRIPTION_PERIOD_SECONDS }
          : {}),
      },
    )) as { ok?: boolean; result?: unknown } | null;
    if (!j?.ok || typeof j.result !== 'string') {
      throw new Error('Telegram не выдал ссылку на счёт Stars');
    }
    return j.result;
  }

  /** Ответ на pre_checkout_query обязателен в течение 10 с (Bot API). */
  async answerPreCheckout(
    token: string,
    id: string,
    ok: boolean,
    errorMessage?: string,
  ): Promise<void> {
    try {
      await this.post(`${TELEGRAM_API}/bot${token}/answerPreCheckoutQuery`, {
        pre_checkout_query_id: id,
        ok,
        ...(errorMessage ? { error_message: errorMessage } : {}),
      });
    } catch (e) {
      this.logger.warn(`answerPreCheckoutQuery: ${(e as Error).name}`);
    }
  }

  /** Отмена/возобновление автопродления Stars в Telegram — best-effort. */
  async setStarsSubscriptionCanceled(
    token: string,
    userId: bigint,
    chargeId: string,
    canceled: boolean,
  ): Promise<boolean> {
    try {
      const j = (await this.post(
        `${TELEGRAM_API}/bot${token}/editUserStarSubscription`,
        {
          user_id: Number(userId),
          telegram_payment_charge_id: chargeId,
          is_canceled: canceled,
        },
      )) as { ok?: boolean } | null;
      return j?.ok === true;
    } catch (e) {
      this.logger.warn(`editUserStarSubscription: ${(e as Error).name}`);
      return false;
    }
  }

  // ── WayForPay (мерчант Помощника) ───────────────────────────────────

  /**
   * Форма покупки — POST на secure.wayforpay.com/pay (TMA строит <form>).
   * recToken для продления WayForPay присылает в вебхуке сам, если мерчант
   * включён на регулярные платежи (как у генератора, §41 открытый вопрос 2).
   */
  purchaseForm(
    cfg: WayForPayConfig,
    input: {
      orderReference: string;
      amountMinor: number;
      currency: string;
      productName: string;
      returnUrl: string;
      serviceUrl: string;
    },
    now: Date = new Date(),
  ): PurchaseForm {
    const amount = input.amountMinor / 100;
    const orderDate = Math.floor(now.getTime() / 1000);
    const merchantSignature = wayforpayPurchaseSignature(
      {
        merchantAccount: cfg.merchantAccount,
        merchantDomainName: cfg.domain,
        orderReference: input.orderReference,
        orderDate,
        amount,
        currency: input.currency,
        productName: input.productName,
      },
      cfg.merchantSecret,
    );
    return {
      url: WAYFORPAY_PURCHASE_URL,
      fields: {
        merchantAccount: cfg.merchantAccount,
        merchantDomainName: cfg.domain,
        merchantSignature,
        orderReference: input.orderReference,
        orderDate: String(orderDate),
        amount: formatWayForPayAmount(amount),
        currency: input.currency,
        'productName[]': input.productName,
        'productCount[]': '1',
        'productPrice[]': formatWayForPayAmount(amount),
        returnUrl: input.returnUrl,
        serviceUrl: input.serviceUrl,
      },
    };
  }

  /** host2host `Charge` по recToken — продление и автодокупка (крон). */
  async charge(
    cfg: WayForPayConfig,
    input: {
      recToken: string;
      orderReference: string;
      amountMinor: number;
      currency: string;
      productName: string;
    },
    now: Date = new Date(),
  ): Promise<ChargeResult> {
    const amount = input.amountMinor / 100;
    const orderDate = Math.floor(now.getTime() / 1000);
    const merchantSignature = wayforpayPurchaseSignature(
      {
        merchantAccount: cfg.merchantAccount,
        merchantDomainName: cfg.domain,
        orderReference: input.orderReference,
        orderDate,
        amount,
        currency: input.currency,
        productName: input.productName,
      },
      cfg.merchantSecret,
    );
    const j = (await this.post(WAYFORPAY_API_URL, {
      transactionType: 'CHARGE',
      merchantAccount: cfg.merchantAccount,
      merchantAuthType: 'SimpleSignature',
      merchantDomainName: cfg.domain,
      merchantSignature,
      apiVersion: 1,
      orderReference: input.orderReference,
      orderDate,
      amount: formatWayForPayAmount(amount),
      currency: input.currency,
      recToken: input.recToken,
      productName: [input.productName],
      productPrice: [formatWayForPayAmount(amount)],
      productCount: [1],
    })) as {
      transactionStatus?: string;
      reasonCode?: number;
      recToken?: string;
    } | null;
    // Аудит Э4: ответ без `transactionStatus` (не JSON — 5xx шлюза, или
    // ошибка запроса вида «Duplicate Order ID» при повторе того же
    // orderReference) — исход списания НЕИЗВЕСТЕН, а не отказ банка. Как
    // `Declined` он помечал платёж failed: следующая попытка шла НОВЫМ
    // orderReference (риск второго списания, если первое прошло), а
    // пришедший позже Approved по первому уже не применялся. `Unknown` —
    // не терминальный статус (WFP_TERMINAL_FAILURES): платёж остаётся
    // pending, повтор — тем же orderReference.
    const status =
      typeof j?.transactionStatus === 'string' && j.transactionStatus
        ? j.transactionStatus
        : CHARGE_STATUS_UNKNOWN;
    return {
      ok: status === 'Approved',
      transactionStatus: status,
      reasonCode: typeof j?.reasonCode === 'number' ? j.reasonCode : -1,
      recToken: typeof j?.recToken === 'string' ? j.recToken : null,
      rawPayload: j,
    };
  }
}
