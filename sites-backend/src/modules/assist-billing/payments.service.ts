/**
 * Факты оплаты Помощника — Stars (бот Помощника) и WayForPay (мерчант
 * Помощника), ТЗ §3.10, §4.1, §7.1; план, Приложение А «Этап 4».
 *
 * Деньги — правила проекта (как `billing/billing.service.ts` генератора,
 * Г-2.4…Г-2.7):
 *  - статус платежа и его последствия (тариф, период, докупка) — ОДНА
 *    транзакция под advisory-замком по провайдерскому id: сбой между ними
 *    откатывает всё, повтор колбэка проходит путь заново с чистого листа;
 *  - смена статуса — условным UPDATE (`WHERE status IN ('pending',
 *    'expired')`): повтор колбэка/параллельная доставка не применит дважды,
 *    продление не удвоится;
 *  - Stars: одна строка на `telegram_payment_charge_id` (уникальность
 *    (method, providerRef)); автопродление (`is_recurring`) — новая строка
 *    `renewal` с parentId первого платежа;
 *  - WayForPay: подпись вебхука проверяется (HMAC-MD5 секретом мерчанта,
 *    общий модуль shared/wayforpay-signature.ts), мерчант, сумма и валюта —
 *    сверяются со строкой; промежуточные статусы (3DS) оставляют pending;
 *    квитанция `accept` отдаётся всегда (иначе провайдер зациклится);
 *  - recToken — только шифром (token-crypto, ключ — производный от
 *    ASSIST_SECRETS_KEY); в rawPayload — без recToken/cardPan/authCode.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptToken } from '../../shared/token-crypto';
import { sanitizeWayForPayRawPayload } from '../../shared/wayforpay-sanitize';
import {
  verifyWayForPayCallback,
  wayforpayAckSignature,
} from '../../shared/wayforpay-signature';
import {
  assistBotToken,
  paymentTokenKey,
  starsSubscriptionMax,
  wayforpayConfig,
} from './billing-env';
import { BillingNotices } from './billing-notices';
import { isAssistPlanId, isPaidPlanId, type AssistPlanId } from './plans';
import { AssistPaymentProviders } from './providers';
import { readSubscription } from './public/entitlements';
import {
  applyPaidPeriod,
  subscriptionState,
  type SubscriptionRow,
} from './subscription-state';
import { randomId } from './ids';

type Tx = Prisma.TransactionClient;

export interface PaymentRow {
  id: string;
  accountId: string;
  kind: string;
  planId: string | null;
  units: number | null;
  method: string;
  status: string;
  currency: string;
  amountMinor: number;
  amountMicroUsd: bigint;
  providerRef: string | null;
  periodKey: string | null;
  expiresAt: Date | null;
  payerTelegramId: bigint | null;
}

export interface WayForPayWebhookBody {
  merchantAccount: string;
  orderReference: string;
  amount: number | string;
  currency: string;
  authCode?: string;
  cardPan?: string;
  transactionStatus: string;
  reasonCode: number | string;
  merchantSignature: string;
  recToken?: string;
}

export interface WayForPayAck {
  orderReference: string;
  status: 'accept';
  time: number;
  signature: string;
}

/** Терминальные отказы WayForPay (Г-2.4): остальное — тот же платёж в пути. */
export const WFP_TERMINAL_FAILURES = new Set(['Declined', 'Expired', 'Voided']);

/** Итог применения — что сделать ПОСЛЕ коммита (сеть — вне транзакции). */
export interface Applied {
  accountId: string;
  kind: string;
  planId: string | null;
  /** Прежняя подписка Stars, которую надо отменить в Telegram. */
  cancelStars: { chargeId: string; payer: bigint } | null;
}

const PAYMENT_SELECT = {
  id: true,
  accountId: true,
  kind: true,
  planId: true,
  units: true,
  method: true,
  status: true,
  currency: true,
  amountMinor: true,
  amountMicroUsd: true,
  providerRef: true,
  periodKey: true,
  expiresAt: true,
  payerTelegramId: true,
} as const;

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null;
}

function tgId(v: unknown): bigint | null {
  return typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : null;
}

@Injectable()
export class AssistPayments {
  private readonly logger = new Logger(AssistPayments.name);
  now: () => Date = () => new Date();
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: AssistPaymentProviders,
    @Optional() private readonly notices?: BillingNotices,
  ) {}

  // ── Применение успешной оплаты (общее для провайдеров и крона) ──────

  /**
   * В транзакции вызывающего (статус платежа уже переведён его условным
   * UPDATE): тариф/период или докупка. Замок кабинета сериализует две
   * оплаты одного кабинета (подписка + докупка в одну секунду).
   */
  async applyInTx(
    tx: Tx,
    p: PaymentRow,
    opts: {
      recTokenEnc?: string | null;
      chargeId?: string | null;
      /** Stars: разовая оплата (счёт без `subscription_period`) — продлевать
       * Telegram не будет. */
      starsOneTime?: boolean;
    } = {},
  ): Promise<Applied> {
    const now = this.now();
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      `assist-sub:${p.accountId}`,
    );
    const curRow = await tx.assistSubscription.findUnique({
      where: { accountId: p.accountId },
    });
    const out: Applied = {
      accountId: p.accountId,
      kind: p.kind,
      planId: p.planId,
      cancelStars: null,
    };
    if (p.kind === 'topup' || p.kind === 'auto_topup') {
      const { trialStart } = await readSubscription(tx, p.accountId);
      const state = subscriptionState(curRow, trialStart, now);
      const periodKey = state.periodKey ?? p.periodKey;
      if (!periodKey) {
        this.logger.error(`докупка ${p.id} без периода — единицы не начислены`);
        return out;
      }
      const units = Math.max(0, p.units ?? 0);
      const auto = p.kind === 'auto_topup';
      await tx.$executeRawUnsafe(
        `INSERT INTO "sites"."assist_account_usage" ("accountId", "periodKey", "updatedAt")
         VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
        p.accountId,
        periodKey,
      );
      // Новый лимит — предупреждения 80/100% снова в силе.
      await tx.$executeRawUnsafe(
        `UPDATE "sites"."assist_account_usage"
            SET "extraUnits" = "extraUnits" + $3,
                "autoPacks" = "autoPacks" + $4,
                "autoSpentMicroUsd" = "autoSpentMicroUsd" + $5,
                "exhaustedAt" = NULL, "warned80At" = NULL, "warned100At" = NULL,
                "updatedAt" = now()
          WHERE "accountId" = $1 AND "periodKey" = $2`,
        p.accountId,
        periodKey,
        units,
        auto ? 1 : 0,
        auto ? p.amountMicroUsd : BigInt(0),
      );
      if (p.periodKey !== periodKey) {
        await tx.assistPayment.update({
          where: { id: p.id },
          data: { periodKey },
        });
      }
      return out;
    }
    if (!isAssistPlanId(p.planId) || p.planId === 'trial') {
      this.logger.error(`платёж ${p.id}: неизвестный тариф ${p.planId}`);
      return out;
    }
    let planId: AssistPlanId = p.planId;
    const cur: SubscriptionRow | null = curRow;
    // Автопродление ПРЕЖНЕЙ (другой) подписки Stars, которую Telegram не
    // отменил: деньги получены — время продлеваем, тариф не меняем
    // (вторая линия защиты М-1.1 генератора).
    if (
      p.kind === 'renewal' &&
      curRow &&
      curRow.status !== 'expired' &&
      curRow.planId !== planId &&
      isPaidPlanId(curRow.planId)
    ) {
      this.logger.error(
        `кабинет ${p.accountId}: автопродление ${planId} при действующем ${curRow.planId} — тариф не меняем`,
      );
      planId = curRow.planId;
      out.planId = planId;
    }
    const period = applyPaidPeriod(cur, planId, now);
    const renewal = p.kind === 'renewal';
    // Автопродление способом, от которого кабинет уже ушёл (старая подписка
    // Stars после перехода на карту): время продлеваем, способ и recToken —
    // как были.
    const keepMethod =
      renewal &&
      !!curRow &&
      curRow.status !== 'expired' &&
      curRow.method !== p.method;
    // Владелец отменил продление, а Telegram успел списать (отмена не
    // дошла): оплаченное время отдаём, но подписку не «реанимируем» (Г-2.2
    // генератора) и повторяем отмену в Telegram.
    const keepCancel = renewal && !!curRow?.cancelAtPeriodEnd;
    const stars = p.method === 'stars' && !keepMethod;
    const firstStarsCharge = stars && !renewal;
    // Аудит Э4: разовая оплата Stars (тариф дороже потолка подписки Stars —
    // счёт без `subscription_period`) не продлевается — без этого строка
    // выглядела «продлеваемой»: льгота 3 дня после конца без оплаты,
    // «продлится автоматически» в кабинете и отмена/возобновление впустую.
    const starsOneTime = firstStarsCharge && opts.starsOneTime === true;
    // Новая подписка (любым способом) заменяет подписку Stars — её
    // автопродление в Telegram отменяется (М-1.1 генератора), иначе Telegram
    // продолжит списывать звёзды за старый тариф.
    if (
      curRow?.method === 'stars' &&
      curRow.starsChargeId &&
      curRow.starsPayerTelegramId &&
      ((!renewal && curRow.starsChargeId !== opts.chargeId) || keepCancel)
    ) {
      out.cancelStars = {
        chargeId: curRow.starsChargeId,
        payer: curRow.starsPayerTelegramId,
      };
    }
    const data = {
      planId,
      status: 'active',
      method: keepMethod && curRow ? curRow.method : p.method,
      anchorAt: period.anchorAt,
      paidThrough: period.paidThrough,
      cancelAtPeriodEnd: keepCancel,
      renewClaimedAt: null,
      renewAttempts: 0,
      lastRenewError: null,
      // Способ сменился на Stars — продлевать картой больше нечем; на
      // карту — подписка Stars отменена выше, её charge больше не нужен.
      ...(stars
        ? { recTokenEnc: null, autoTopUp: false }
        : !renewal
          ? { starsChargeId: null, starsPayerTelegramId: null }
          : {}),
      ...(opts.recTokenEnc ? { recTokenEnc: opts.recTokenEnc } : {}),
      ...(firstStarsCharge && opts.chargeId && !starsOneTime
        ? {
            starsChargeId: opts.chargeId,
            starsPayerTelegramId: p.payerTelegramId,
          }
        : {}),
      ...(starsOneTime
        ? {
            cancelAtPeriodEnd: true,
            starsChargeId: null,
            starsPayerTelegramId: null,
          }
        : {}),
    };
    await tx.assistSubscription.upsert({
      where: { accountId: p.accountId },
      create: { accountId: p.accountId, ...data },
      update: data,
    });
    return out;
  }

  /** После коммита: отменить прежнюю подписку Stars, уведомить владельца. */
  async afterApplied(a: Applied | null): Promise<void> {
    if (!a) return;
    const token = assistBotToken(this.env);
    if (a.cancelStars && token) {
      const ok = await this.providers.setStarsSubscriptionCanceled(
        token,
        a.cancelStars.payer,
        a.cancelStars.chargeId,
        true,
      );
      if (!ok) {
        this.logger.warn(
          `кабинет ${a.accountId}: прежняя подписка Stars не отменена в Telegram — проверить вручную`,
        );
      }
    }
    await this.notices
      ?.paymentApplied(a.accountId, a.kind, a.planId)
      .catch((e: unknown) =>
        this.logger.warn(`уведомление об оплате: ${(e as Error).name}`),
      );
  }

  // ── Telegram Stars (вебхук бота Помощника) ─────────────────────────

  /** true — обновление про оплату (обработано здесь), false — не наше. */
  async handleTelegramUpdate(update: unknown): Promise<boolean> {
    const u = obj(update);
    if (!u) return false;
    const pre = obj(u.pre_checkout_query);
    if (pre) {
      await this.preCheckout(pre);
      return true;
    }
    const msg = obj(u.message);
    const sp = msg ? obj(msg.successful_payment) : null;
    if (sp && msg) {
      await this.starsSuccess(sp, tgId(obj(msg.from)?.id));
      return true;
    }
    return false;
  }

  private async preCheckout(q: Record<string, unknown>): Promise<void> {
    const token = assistBotToken(this.env);
    const id = str(q.id);
    if (!token || !id) return;
    const verdict = await this.preCheckoutVerdict(q);
    await this.providers.answerPreCheckout(
      token,
      id,
      verdict === null,
      verdict ?? undefined,
    );
  }

  /** null — платить можно; иначе текст отказа для человека. */
  async preCheckoutVerdict(q: Record<string, unknown>): Promise<string | null> {
    const paymentId = str(q.invoice_payload);
    const row = paymentId
      ? await this.prisma.assistPayment.findUnique({
          where: { id: paymentId },
          select: PAYMENT_SELECT,
        })
      : null;
    if (!row || row.method !== 'stars') {
      return 'Счёт не найден — начните оплату заново в приложении';
    }
    if (row.status !== 'pending') {
      return row.status === 'succeeded'
        ? 'Этот счёт уже оплачен'
        : 'Счёт устарел — начните оплату заново в приложении';
    }
    if (row.expiresAt && row.expiresAt.getTime() <= this.now().getTime()) {
      return 'Счёт устарел — начните оплату заново в приложении';
    }
    if (q.currency !== 'XTR' || q.total_amount !== row.amountMinor) {
      return 'Сумма счёта изменилась — начните оплату заново в приложении';
    }
    return null;
  }

  private async starsSuccess(
    sp: Record<string, unknown>,
    payer: bigint | null,
  ): Promise<void> {
    const chargeId = str(sp.telegram_payment_charge_id);
    const paymentId = str(sp.invoice_payload);
    const total = typeof sp.total_amount === 'number' ? sp.total_amount : NaN;
    const recurring = sp.is_recurring === true;
    // Признак подписки — от Telegram (первый платёж подписки несёт
    // is_first_recurring / subscription_expiration_date); нет ни одного —
    // тот же расчёт, что при выставлении счёта (checkout: подписка Stars,
    // только если сумма в пределах ASSIST_STARS_SUBSCRIPTION_MAX).
    const telegramSubscription =
      recurring ||
      sp.is_first_recurring === true ||
      typeof sp.subscription_expiration_date === 'number';
    if (!chargeId || !paymentId || !Number.isSafeInteger(total)) {
      this.logger.error('successful_payment без charge/payload — пропуск');
      return;
    }
    const applied = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        `assist-pay:stars:${chargeId}`,
      );
      const dup = await tx.assistPayment.findUnique({
        where: {
          method_providerRef: { method: 'stars', providerRef: chargeId },
        },
        select: { id: true },
      });
      if (dup) return null; // повтор доставки — уже применено
      const row = await tx.assistPayment.findUnique({
        where: { id: paymentId },
        select: PAYMENT_SELECT,
      });
      if (!row || row.method !== 'stars') {
        // Деньги списаны, а счёт не наш — оператору, а не молча.
        this.logger.error(
          `Stars: оплата по неизвестному счёту ${paymentId}, charge ${chargeId}`,
        );
        return null;
      }
      if (total !== row.amountMinor) {
        this.logger.error(
          `Stars: сумма ${total} ≠ ${row.amountMinor} у счёта ${row.id} — применяем (деньги получены)`,
        );
      }
      const now = this.now();
      const won = await tx.assistPayment.updateMany({
        where: { id: row.id, status: { in: ['pending', 'expired', 'failed'] } },
        data: {
          status: 'succeeded',
          providerRef: chargeId,
          payerTelegramId: payer,
          recurring,
          paidAt: now,
          amountMinor: total,
        },
      });
      if (won.count === 1) {
        const starsOneTime =
          row.kind === 'subscription' &&
          !telegramSubscription &&
          row.amountMinor > starsSubscriptionMax(this.env);
        return this.applyInTx(
          tx,
          { ...row, payerTelegramId: payer, amountMinor: total },
          { chargeId, starsOneTime },
        );
      }
      // Счёт уже оплачен: автопродление подписки Stars (тот же payload) или
      // повторная оплата той же ссылки в гонке — деньги получены, новая строка.
      const kind =
        row.kind === 'subscription' || row.kind === 'renewal'
          ? 'renewal'
          : row.kind;
      const created = await tx.assistPayment.create({
        data: {
          id: randomId('rn'),
          accountId: row.accountId,
          kind,
          planId: row.planId,
          units: row.units,
          method: 'stars',
          status: 'succeeded',
          currency: 'XTR',
          amountMinor: total,
          amountMicroUsd: row.amountMicroUsd,
          providerRef: chargeId,
          parentId: row.id,
          periodKey: row.periodKey,
          recurring,
          payerTelegramId: payer,
          paidAt: now,
        },
        select: PAYMENT_SELECT,
      });
      return this.applyInTx(tx, created, { chargeId });
    });
    await this.afterApplied(applied);
  }

  // ── WayForPay (serviceUrl мерчанта Помощника) ──────────────────────

  async handleWayForPay(
    body: WayForPayWebhookBody,
  ): Promise<WayForPayAck | null> {
    const cfg = wayforpayConfig(this.env);
    if (!cfg) return null;
    const orderReference =
      typeof body.orderReference === 'string' ? body.orderReference : '';
    const time = Math.floor(this.now().getTime() / 1000);
    const ack: WayForPayAck = {
      orderReference,
      status: 'accept',
      time,
      signature: wayforpayAckSignature(
        orderReference,
        time,
        cfg.merchantSecret,
      ),
    };
    if (
      typeof body.merchantSignature !== 'string' ||
      body.merchantAccount !== cfg.merchantAccount ||
      !verifyWayForPayCallback(body, cfg.merchantSecret)
    ) {
      this.logger.error(
        `WayForPay: неверная подпись/мерчант, order ${orderReference.slice(0, 64)}`,
      );
      return ack;
    }
    const row = await this.prisma.assistPayment.findUnique({
      where: { id: orderReference },
      select: PAYMENT_SELECT,
    });
    if (!row || row.method !== 'wayforpay') {
      this.logger.error(
        `WayForPay: неизвестный orderReference ${orderReference.slice(0, 64)}`,
      );
      return ack;
    }
    const raw = sanitizeWayForPayRawPayload(body) as Prisma.InputJsonValue;
    if (body.transactionStatus !== 'Approved') {
      if (WFP_TERMINAL_FAILURES.has(body.transactionStatus)) {
        await this.prisma.assistPayment.updateMany({
          where: { id: row.id, status: 'pending' },
          data: {
            status: 'failed',
            failureReason:
              `${body.transactionStatus} (${String(body.reasonCode)})`.slice(
                0,
                200,
              ),
            rawPayload: raw,
          },
        });
      }
      return ack;
    }
    const amountMinor = Math.round(Number(body.amount) * 100);
    if (amountMinor !== row.amountMinor || body.currency !== row.currency) {
      this.logger.error(
        `WayForPay: сумма/валюта ${String(body.amount)} ${body.currency} ≠ счёту ${row.id} — не применяем`,
      );
      await this.prisma.assistPayment.updateMany({
        where: { id: row.id, status: { in: ['pending', 'expired'] } },
        data: {
          status: 'failed',
          failureReason: 'amount_mismatch',
          rawPayload: raw,
        },
      });
      return ack;
    }
    const key = paymentTokenKey(this.env);
    const recTokenEnc =
      body.recToken && key ? encryptToken(body.recToken, key) : null;
    const applied = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        `assist-pay:wayforpay:${row.id}`,
      );
      const won = await tx.assistPayment.updateMany({
        where: { id: row.id, status: { in: ['pending', 'expired'] } },
        data: {
          status: 'succeeded',
          providerRef: row.id,
          paidAt: this.now(),
          rawPayload: raw,
        },
      });
      if (won.count !== 1) return null; // повтор доставки
      return this.applyInTx(tx, row, { recTokenEnc });
    });
    await this.afterApplied(applied);
    return ack;
  }

  /**
   * Списание по recToken кроном (продление, автодокупка) прошло: та же
   * условная смена статуса и применение, что у вебхука (вебхук того же
   * orderReference после этого — повтор, без второго применения).
   */
  async settleCharge(
    paymentId: string,
    result: {
      ok: boolean;
      status: string;
      reason: string;
      raw: unknown;
      recToken: string | null;
    },
  ): Promise<'applied' | 'failed' | 'pending' | 'duplicate'> {
    const raw = sanitizeWayForPayRawPayload(
      result.raw,
    ) as Prisma.InputJsonValue;
    if (!result.ok) {
      if (!WFP_TERMINAL_FAILURES.has(result.status)) return 'pending';
      await this.prisma.assistPayment.updateMany({
        where: { id: paymentId, status: 'pending' },
        data: {
          status: 'failed',
          failureReason: result.reason.slice(0, 200),
          rawPayload: raw,
        },
      });
      return 'failed';
    }
    const key = paymentTokenKey(this.env);
    const recTokenEnc =
      result.recToken && key ? encryptToken(result.recToken, key) : null;
    const applied = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        `assist-pay:wayforpay:${paymentId}`,
      );
      const row = await tx.assistPayment.findUnique({
        where: { id: paymentId },
        select: PAYMENT_SELECT,
      });
      if (!row) return null;
      const won = await tx.assistPayment.updateMany({
        where: { id: paymentId, status: { in: ['pending', 'expired'] } },
        data: {
          status: 'succeeded',
          providerRef: paymentId,
          paidAt: this.now(),
          rawPayload: raw,
        },
      });
      if (won.count !== 1) return null;
      return this.applyInTx(tx, row, { recTokenEnc });
    });
    if (!applied) return 'duplicate';
    await this.afterApplied(applied);
    return 'applied';
  }
}
