/**
 * Стенд Э4: платёжные провайдеры — ТОЛЬКО моки (сеть не трогается),
 * env оплаты — тестовые значения, сервисы — на реальном Postgres.
 */
import { SitesDb } from '../../../prisma/sites-db.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import { wayforpayCallbackSignature } from '../../../shared/wayforpay-signature';
import type { WayForPayConfig } from '../billing-env';
import { BillingNotices } from '../billing-notices';
import { AssistBillingTick } from '../billing-tick.service';
import { AssistBilling } from '../billing.service';
import { AssistPayments, type WayForPayWebhookBody } from '../payments.service';
import {
  AssistPaymentProviders,
  type ChargeResult,
  type StarsInvoiceInput,
} from '../providers';

export const E4_WFP = {
  merchantAccount: 'assist_test_merchant',
  merchantSecret: 'e4-merchant-secret-0123456789',
  domain: 'assist.example.com',
};

export const E4_SECRETS_KEY = 'e4-secrets-key-for-tests-0123456789abcdef';

export function billingEnv(
  over: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ASSIST_BOT_TOKEN: 'e4-bot-token',
    ASSIST_TMA_URL: 'https://tma.e4.example.com',
    ASSIST_SECRETS_KEY: E4_SECRETS_KEY,
    SITES_PUBLIC_URL: 'https://api.e4.example.com',
    ASSIST_WAYFORPAY_MERCHANT_ACCOUNT: E4_WFP.merchantAccount,
    ASSIST_WAYFORPAY_MERCHANT_SECRET: E4_WFP.merchantSecret,
    ASSIST_WAYFORPAY_DOMAIN: E4_WFP.domain,
    ASSIST_UAH_PER_USD: '41.5',
    ASSIST_STARS_PER_USD: '77',
    ...over,
  };
}

/** Мок провайдеров: записывает вызовы, ответы задаёт тест. */
export class FakeProviders extends AssistPaymentProviders {
  readonly invoices: StarsInvoiceInput[] = [];
  readonly preCheckouts: Array<{ id: string; ok: boolean; error?: string }> =
    [];
  readonly charges: Array<{
    orderReference: string;
    amountMinor: number;
    recToken: string;
  }> = [];
  readonly starsCancels: Array<{ chargeId: string; canceled: boolean }> = [];
  chargeResult: (orderReference: string) => ChargeResult = () => ({
    ok: true,
    transactionStatus: 'Approved',
    reasonCode: 1100,
    recToken: null,
    rawPayload: { transactionStatus: 'Approved', recToken: 'must-be-stripped' },
  });

  constructor() {
    super();
    this.fetchImpl = async () => {
      throw new Error('E4: сеть в тестах запрещена — только моки');
    };
  }

  override async createStarsInvoiceLink(
    _token: string,
    input: StarsInvoiceInput,
  ): Promise<string> {
    this.invoices.push(input);
    return `https://t.me/$e4-invoice-${this.invoices.length}`;
  }

  override async answerPreCheckout(
    _token: string,
    id: string,
    ok: boolean,
    error?: string,
  ): Promise<void> {
    this.preCheckouts.push({ id, ok, error });
  }

  override async setStarsSubscriptionCanceled(
    _token: string,
    _userId: bigint,
    chargeId: string,
    canceled: boolean,
  ): Promise<boolean> {
    this.starsCancels.push({ chargeId, canceled });
    return true;
  }

  override async charge(
    _cfg: WayForPayConfig,
    input: {
      recToken: string;
      orderReference: string;
      amountMinor: number;
      currency: string;
      productName: string;
    },
  ): Promise<ChargeResult> {
    this.charges.push({
      orderReference: input.orderReference,
      amountMinor: input.amountMinor,
      recToken: input.recToken,
    });
    return this.chargeResult(input.orderReference);
  }
}

/** Тело вебхука WayForPay с ВЕРНОЙ подписью (как его шлёт провайдер). */
export function wfpCallback(
  orderReference: string,
  amountMinor: number,
  over: Partial<WayForPayWebhookBody> = {},
  secret = E4_WFP.merchantSecret,
): WayForPayWebhookBody {
  const body = {
    merchantAccount: E4_WFP.merchantAccount,
    orderReference,
    amount: amountMinor / 100,
    currency: 'UAH',
    authCode: '541963',
    cardPan: '41****8217',
    transactionStatus: 'Approved',
    reasonCode: 1100,
    ...over,
  } as WayForPayWebhookBody;
  return {
    ...body,
    merchantSignature:
      over.merchantSignature ?? wayforpayCallbackSignature(body, secret),
  };
}

export interface BillingServices {
  providers: FakeProviders;
  payments: AssistPayments;
  billing: AssistBilling;
  tick: AssistBillingTick;
  notices: BillingNotices;
  sent: Array<{ chat_id: string; text: string }>;
}

/** Сервисы Э4 на клиенте владельца схемы с моками провайдеров и бота. */
export function billingServices(
  owner: PrismaService,
  env: NodeJS.ProcessEnv = billingEnv(),
): BillingServices {
  const sitesDb = new SitesDb(owner);
  const providers = new FakeProviders();
  const sent: Array<{ chat_id: string; text: string }> = [];
  const notices = new BillingNotices(sitesDb);
  notices.env = env;
  notices.fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body) as { chat_id: string; text: string });
    return { ok: true, status: 200 };
  };
  const payments = new AssistPayments(owner, providers, notices);
  payments.env = env;
  const billing = new AssistBilling(sitesDb, providers);
  billing.env = env;
  const tick = new AssistBillingTick(owner, payments, providers, notices);
  tick.env = env;
  return { providers, payments, billing, tick, notices, sent };
}
