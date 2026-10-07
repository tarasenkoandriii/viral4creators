/**
 * Кабинет «Тариф и оплата» (ТЗ §3.10, §7.1, §3.1 — Условия и DPA): сводка
 * тарифа и счётчика, принятие документов, чекаут Stars/WayForPay, докупка,
 * автодокупка с потолком, отмена/возобновление продления.
 *
 * Сумма к оплате считается ЗДЕСЬ по `ASSIST_PLANS` и курсам env — клиент
 * присылает только что купить (тариф или число пакетов) и способ. Строка
 * платежа (pending) создаётся до счёта: её id — payload счёта Stars и
 * orderReference WayForPay; колбэк провайдера ищет её по нему.
 */

import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import type { AccountMembership } from '../site-core/account/roles';
import type {
  AutoTopUpRequest,
  BillingErrorCode,
  BillingOverview,
  BillingPlanView,
  CheckoutRequest,
  CheckoutResult,
  LegalAcceptRequest,
  PaymentStatusView,
} from './api-types';
import {
  LEGAL_DOCUMENTS,
  assistBotToken,
  billingReturnUrl,
  legalUrl,
  paymentRates,
  sitesPublicUrl,
  starsSubscriptionMax,
  wayforpayConfig,
  type LegalDocument,
} from './billing-env';
import { randomId } from './ids';
import {
  ASSIST_PLANS,
  ASSIST_PLAN_IDS,
  MICRO,
  TOPUP_MAX_PACKS,
  TOPUP_PACK_UNITS,
  isPaidPlanId,
  planPrice,
  topupPrice,
  type PlanPrice,
} from './plans';
import { AssistPaymentProviders } from './providers';
import {
  autoAllowanceUnits,
  isInternalAccount,
  readState,
  readUsage,
} from './public/entitlements';
import { unitsLimit } from './subscription-state';
import { PUBLIC_DIALOG_WEIGHTS } from './units';

/** Ссылка на счёт Stars живёт 30 минут (pre_checkout после — отказ). */
const STARS_LINK_TTL_MS = 30 * 60 * 1000;
/** Форма WayForPay — сутки (3DS, банк). */
const WAYFORPAY_TTL_MS = 24 * 60 * 60 * 1000;
/** Потолок автодокупки за период — не больше (защита от опечатки). */
const AUTO_TOPUP_MAX_USD = 1000;

export function billingError(
  code: BillingErrorCode,
  message: string,
  status: number,
): HttpException {
  return new HttpException({ message, error: code, code }, status);
}

const PLAN_TITLES: Record<string, string> = {
  start: 'Start',
  business: 'Business',
  pro: 'Pro',
};

@Injectable()
export class AssistBilling {
  private readonly logger = new Logger(AssistBilling.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly providers: AssistPaymentProviders,
  ) {}

  private raw(reason: string) {
    return this.sitesDb.system(reason);
  }

  private methods(): { stars: boolean; wayforpay: boolean } {
    return {
      stars: !!assistBotToken(this.env),
      wayforpay:
        !!wayforpayConfig(this.env) &&
        !!sitesPublicUrl(this.env) &&
        !!billingReturnUrl(this.env),
    };
  }

  private async legalStatus(accountId: string) {
    const rows = await this.sitesDb
      .forAccount(accountId)
      .assistLegalAcceptance.findMany({
        select: { document: true, version: true, evalConsent: true },
      });
    const accepted = (doc: LegalDocument) =>
      rows.some(
        (r) => r.document === doc && r.version === LEGAL_DOCUMENTS[doc].version,
      );
    const dpa = rows.find(
      (r) => r.document === 'dpa' && r.version === LEGAL_DOCUMENTS.dpa.version,
    );
    return {
      terms: {
        version: LEGAL_DOCUMENTS.terms.version,
        url: legalUrl('terms', this.env),
        accepted: accepted('terms'),
      },
      dpa: {
        version: LEGAL_DOCUMENTS.dpa.version,
        url: legalUrl('dpa', this.env),
        accepted: accepted('dpa'),
      },
      evalConsent: dpa?.evalConsent ?? false,
    };
  }

  async overview(m: AccountMembership): Promise<BillingOverview> {
    const now = this.now();
    const db = this.raw('кабинет: тариф и счётчик единиц');
    const state = await readState(db, m.accountId, now, this.env);
    const usage = await readUsage(db, m.accountId, state.periodKey);
    const sub = await this.sitesDb
      .forAccount(m.accountId)
      .assistSubscription.findFirst({ select: { recTokenEnc: true } });
    const rates = paymentRates(this.env);
    const owner = m.role === 'owner';
    const plans: BillingPlanView[] = ASSIST_PLAN_IDS.map((id) => {
      const p = ASSIST_PLANS[id];
      const price = isPaidPlanId(id) ? planPrice(id, rates) : null;
      return {
        id,
        priceUsdMonthly: p.priceUsdMonthly,
        dialogsPerMonth: p.dialogsPerMonth,
        sites: p.sites,
        knowledgePages: p.knowledgePages,
        documents: p.documents,
        telegramOperators: p.telegramOperators,
        retentionDays: p.retentionDays,
        overageUsdPer100: p.overageUsdPer100,
        voice: p.voice,
        video: p.video,
        adminRead: p.adminRead,
        adminActions: p.adminActions,
        removePoweredBy: p.removePoweredBy,
        price: price ? { uahMinor: price.uahMinor, stars: price.stars } : null,
      };
    });
    const pack =
      state.planId && state.planId !== 'trial'
        ? topupPrice(state.planId, 1, rates)
        : null;
    const payments = owner
      ? await this.sitesDb.forAccount(m.accountId).assistPayment.findMany({
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            kind: true,
            planId: true,
            units: true,
            method: true,
            status: true,
            currency: true,
            amountMinor: true,
            createdAt: true,
            paidAt: true,
          },
        })
      : [];
    return {
      plan: {
        id: state.planId,
        status: state.status,
        method: state.method,
        periodStart: state.periodStart?.toISOString() ?? null,
        periodEnd: state.periodEnd?.toISOString() ?? null,
        paidThrough: state.paidThrough?.toISOString() ?? null,
        renews: state.renews,
        cancelAtPeriodEnd: state.cancelAtPeriodEnd,
      },
      usage: {
        units: usage.units,
        dialogs: usage.dialogs,
        limit: unitsLimit(state, usage.extraUnits),
        planUnits: state.planId
          ? ASSIST_PLANS[state.planId].dialogsPerMonth
          : 0,
        extraUnits: usage.extraUnits,
        autoAllowance: autoAllowanceUnits(state, usage),
      },
      autoTopUp: {
        enabled: state.autoTopUp,
        capUsd: state.autoTopUpCapMicroUsd / MICRO,
        spentUsd: usage.autoSpentMicroUsd / MICRO,
        available: !!pack && state.method === 'wayforpay' && !!sub?.recTokenEnc,
      },
      plans,
      topup:
        pack && state.planId
          ? {
              packUnits: TOPUP_PACK_UNITS,
              maxPacks: TOPUP_MAX_PACKS,
              priceUsdPer100: ASSIST_PLANS[state.planId].overageUsdPer100 ?? 0,
              pricePerPack: { uahMinor: pack.uahMinor, stars: pack.stars },
            }
          : null,
      methods: this.methods(),
      legal: await this.legalStatus(m.accountId),
      payments: payments.map((p) => ({
        ...p,
        createdAt: p.createdAt.toISOString(),
        paidAt: p.paidAt?.toISOString() ?? null,
      })),
      canPay: owner,
      dialogWeights: { ...PUBLIC_DIALOG_WEIGHTS },
    };
  }

  async acceptLegal(
    m: AccountMembership,
    body: LegalAcceptRequest,
  ): Promise<BillingOverview['legal']> {
    const db = this.sitesDb.forAccount(m.accountId);
    for (const doc of body.accept) {
      const version = LEGAL_DOCUMENTS[doc].version;
      const evalConsent = doc === 'dpa' ? body.evalConsent === true : false;
      await db.assistLegalAcceptance.upsert({
        where: {
          accountId_document_version: {
            accountId: m.accountId,
            document: doc,
            version,
          },
        },
        create: {
          accountId: m.accountId,
          document: doc,
          version,
          evalConsent,
          acceptedByTelegramId: m.telegramId,
        },
        update: doc === 'dpa' ? { evalConsent } : {},
      });
    }
    if (body.evalConsent !== undefined && !body.accept.includes('dpa')) {
      // Согласие на eval — пункт DPA: меняется только у принятой версии.
      await db.assistLegalAcceptance.updateMany({
        where: { document: 'dpa', version: LEGAL_DOCUMENTS.dpa.version },
        data: { evalConsent: body.evalConsent },
      });
    }
    return this.legalStatus(m.accountId);
  }

  async checkout(
    m: AccountMembership,
    req: CheckoutRequest,
  ): Promise<CheckoutResult> {
    // Ш5 (4) / Ш6 (8): внутренний тенант не платит — ни подписку, ни
    // докупку (лимита единиц у него нет, деньги держат суточные потолки).
    if (
      await isInternalAccount(
        this.raw('кабинет: внутренний тенант'),
        m.accountId,
        this.env,
      )
    ) {
      throw billingError(
        'INTERNAL_PLAN',
        'Внутренний тариф платформы — оплата не нужна',
        HttpStatus.CONFLICT,
      );
    }
    const legal = await this.legalStatus(m.accountId);
    if (!legal.terms.accepted || !legal.dpa.accepted) {
      throw billingError(
        'LEGAL_REQUIRED',
        'Перед оплатой примите Условия и DPA',
        HttpStatus.CONFLICT,
      );
    }
    const rates = paymentRates(this.env);
    const now = this.now();
    let price: PlanPrice;
    let title: string;
    let subscription = false;
    let periodKey: string | null = null;
    let units: number | null = null;
    let planId: string | null = null;
    if (req.kind === 'subscription') {
      price = planPrice(req.planId, rates);
      title = `Помощник ${PLAN_TITLES[req.planId]} — 30 дней`;
      subscription = true;
      planId = req.planId;
    } else {
      const state = await readState(
        this.raw('кабинет: докупка — текущий тариф'),
        m.accountId,
        now,
        this.env,
      );
      const p =
        state.planId && state.planId !== 'trial'
          ? topupPrice(state.planId, req.packs, rates)
          : null;
      if (!p || !state.periodKey) {
        throw billingError(
          'TOPUP_UNAVAILABLE',
          'Докупка доступна на платном тарифе в течение оплаченного периода',
          HttpStatus.CONFLICT,
        );
      }
      price = p;
      units = req.packs * TOPUP_PACK_UNITS;
      title = `Помощник: +${units} диалогов`;
      periodKey = state.periodKey;
      planId = state.planId;
    }
    const methods = this.methods();
    if (!methods[req.method]) {
      throw billingError(
        'PAYMENT_METHOD_UNAVAILABLE',
        req.method === 'stars'
          ? 'Оплата Stars сейчас недоступна'
          : 'Оплата картой сейчас недоступна',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const id = randomId('ap');
    const stars = req.method === 'stars';
    await this.sitesDb.forAccount(m.accountId).assistPayment.create({
      data: {
        id,
        accountId: m.accountId,
        kind: req.kind,
        planId,
        units,
        method: req.method,
        status: 'pending',
        currency: stars ? 'XTR' : 'UAH',
        amountMinor: stars ? price.stars : price.uahMinor,
        amountMicroUsd: BigInt(Math.round(price.usd * MICRO)),
        periodKey,
        createdByTelegramId: m.telegramId,
        expiresAt: new Date(
          now.getTime() + (stars ? STARS_LINK_TTL_MS : WAYFORPAY_TTL_MS),
        ),
      },
    });
    if (stars) {
      // Подписка Stars с автопродлением — если сумма в пределах потолка
      // `subscription_period`; иначе — разовая оплата 30 дней.
      const auto =
        subscription && price.stars <= starsSubscriptionMax(this.env);
      const url = await this.providers.createStarsInvoiceLink(
        assistBotToken(this.env) as string,
        {
          title,
          description: auto
            ? 'Тариф ИИ-помощника на 30 дней, продлевается автоматически через Telegram Stars'
            : subscription
              ? 'Тариф ИИ-помощника на 30 дней'
              : 'Пакет диалогов к текущему периоду',
          payload: id,
          amount: price.stars,
          subscription: auto,
        },
      );
      return { paymentId: id, method: 'stars', starsInvoiceUrl: url };
    }
    const cfg = wayforpayConfig(this.env)!;
    const form = this.providers.purchaseForm(
      cfg,
      {
        orderReference: id,
        amountMinor: price.uahMinor,
        currency: 'UAH',
        productName: title,
        returnUrl: billingReturnUrl(this.env)!,
        serviceUrl: `${sitesPublicUrl(this.env)}/assist/billing/webhook/wayforpay`,
      },
      now,
    );
    return { paymentId: id, method: 'wayforpay', wayforpay: form };
  }

  async payment(m: AccountMembership, id: string): Promise<PaymentStatusView> {
    const row = await this.sitesDb
      .forAccount(m.accountId)
      .assistPayment.findFirst({
        where: { id },
        select: { id: true, status: true, kind: true, planId: true },
      });
    if (!row) {
      throw billingError(
        'PAYMENT_NOT_FOUND',
        'Платёж не найден',
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  async setAutoTopUp(
    m: AccountMembership,
    req: AutoTopUpRequest,
  ): Promise<BillingOverview> {
    const db = this.sitesDb.forAccount(m.accountId);
    if (req.enabled) {
      const state = await readState(
        this.raw('кабинет: автодокупка — текущий тариф'),
        m.accountId,
        this.now(),
        this.env,
      );
      if (state.internal) {
        throw billingError(
          'INTERNAL_PLAN',
          'Внутренний тариф платформы — автодокупка не нужна',
          HttpStatus.CONFLICT,
        );
      }
      const sub = await db.assistSubscription.findFirst({
        select: { recTokenEnc: true, method: true },
      });
      const overage =
        state.planId !== null && ASSIST_PLANS[state.planId].overageUsdPer100;
      if (!overage || sub?.method !== 'wayforpay' || !sub.recTokenEnc) {
        throw billingError(
          'AUTO_TOPUP_UNAVAILABLE',
          'Автодокупка работает на платном тарифе, оплаченном картой (WayForPay)',
          HttpStatus.CONFLICT,
        );
      }
      if (!(req.capUsd >= overage) || req.capUsd > AUTO_TOPUP_MAX_USD) {
        throw billingError(
          'BILLING_INVALID',
          `Потолок автодокупки — от $${overage} (один пакет) до $${AUTO_TOPUP_MAX_USD} за период`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    await db.assistSubscription.updateMany({
      data: {
        autoTopUp: req.enabled,
        autoTopUpCapMicroUsd: BigInt(
          Math.round(Math.max(0, req.capUsd) * MICRO),
        ),
      },
    });
    return this.overview(m);
  }

  /** Отменить (true) или вернуть (false) автопродление. Доступ — до конца оплаченного. */
  async setCancel(
    m: AccountMembership,
    cancel: boolean,
  ): Promise<BillingOverview> {
    const db = this.sitesDb.forAccount(m.accountId);
    const sub = await db.assistSubscription.findFirst({
      select: {
        method: true,
        starsChargeId: true,
        starsPayerTelegramId: true,
        status: true,
      },
    });
    if (
      !sub ||
      sub.status === 'expired' ||
      !['stars', 'wayforpay'].includes(sub.method)
    ) {
      throw billingError(
        'BILLING_INVALID',
        'Автопродления нет — отменять нечего',
        HttpStatus.CONFLICT,
      );
    }
    // Разовая оплата Stars (счёт без подписки — AssistPayments.applyInTx,
    // starsOneTime): Telegram её не продлит, «возобновлять» нечего.
    if (!cancel && sub.method === 'stars' && !sub.starsChargeId) {
      throw billingError(
        'BILLING_INVALID',
        'Оплата Stars была разовой — продлить тариф можно новой оплатой',
        HttpStatus.CONFLICT,
      );
    }
    await db.assistSubscription.updateMany({
      data: {
        cancelAtPeriodEnd: cancel,
        ...(cancel ? { autoTopUp: false } : {}),
      },
    });
    const token = assistBotToken(this.env);
    if (
      sub.method === 'stars' &&
      sub.starsChargeId &&
      sub.starsPayerTelegramId &&
      token
    ) {
      const ok = await this.providers.setStarsSubscriptionCanceled(
        token,
        sub.starsPayerTelegramId,
        sub.starsChargeId,
        cancel,
      );
      if (!ok) {
        this.logger.warn(
          `кабинет ${m.accountId}: Telegram не подтвердил ${cancel ? 'отмену' : 'возобновление'} подписки Stars`,
        );
      }
    }
    return this.overview(m);
  }
}
