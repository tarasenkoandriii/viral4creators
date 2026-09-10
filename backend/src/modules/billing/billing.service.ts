/**
 * BillingService — оркестрация покупки поверх обоих провайдеров (ТЗ
 * §41.2, этап 62): старт чекаута, обработка вебхуков, применение
 * успешной оплаты (подписка → `PlanService.applyPurchasedPlan`, пакет →
 * `CreditLedgerService.grant`).
 *
 * ## Почему у Stars и WayForPay разное место создания строки `Payment`
 *
 * WayForPay: строка создаётся PENDING ДО редиректа — форме покупки нужен
 * стабильный `orderReference`, а вебхуку — что обновлять по нему.
 *
 * Stars: строка создаётся ТОЛЬКО в вебхуке, сразу SUCCEEDED — Telegram
 * ничего не «открывает» заранее на нашей стороне, весь чекаут — это
 * подписанный `payload` инвойса, который сам Telegram возвращает нам в
 * `successful_payment`; заводить PENDING-заготовку, для которой нет
 * стабильного `providerRef` до самого платежа (только
 * `telegram_payment_charge_id`, известный лишь ПОСЛЕ оплаты), было бы
 * лишней сущностью без работы.
 */

import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { CreditLedgerService } from '../credit-ledger/credit-ledger.service';
import { TelegramStarsService } from './telegram-stars.service';
import { WayForPayService } from './wayforpay.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import {
  signStarsInvoicePayload,
  verifyStarsInvoicePayload,
} from './stars-invoice-payload.util';
import {
  creditPackById,
  creditPacks,
  estimateAmountMicroUsd,
  subscriptionPriceFor,
} from '../../common/billing-pricing';
import { loadConfiguration } from '../../config/configuration';
import { encryptToken } from '../../common/token-crypto';
import { PlanId } from '../../common/plans';
import { sanitizeWayForPayRawPayload } from '../../common/wayforpay-sanitize';
import { CheckoutResult, PaymentMethodValue } from './billing.types';
import { DEFAULT_LOCALE, SupportedLocale } from '../../common/locale';
import { LegalService } from '../legal/legal.service';

const SUBSCRIPTION_PERIOD_DAYS = 30;

/** Форма тела Telegram Update, в той части, которая нас интересует
 * (Bot API — полный тип намного больше, здесь только используемые поля). */
export interface TelegramUpdateBody {
  pre_checkout_query?: {
    id: string;
    invoice_payload: string;
  };
  message?: {
    successful_payment?: {
      telegram_payment_charge_id: string;
      invoice_payload: string;
      total_amount: number;
      is_recurring?: boolean;
    };
  };
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

/** Терминальные статусы WayForPay — только они означают, что платёж не
 * состоится (Г-2.4, аудит round4). Всё остальное (`InProcessing`,
 * `WaitingAuthComplete`, `Pending` — 3DS ждёт банк) — промежуточное
 * состояние одного и того же платежа, а не отказ; для украинских карт
 * 3DS-подтверждение — обычный шаг, не исключение. */
const TERMINAL_FAILURE_STATUSES = new Set(['Declined', 'Expired', 'Voided']);

/** Отличимый от `PlanId | null` маркер «эта доставка вебхука уже была
 * применена раньше» — конкурентная/повторная доставка внутри
 * `$transaction` под advisory-замком (Г-2.5/Г-2.6). */
const ALREADY_PROCESSED = Symbol('billing:already-processed');

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly creditLedger: CreditLedgerService,
    private readonly stars: TelegramStarsService,
    private readonly wayforpay: WayForPayService,
    private readonly notify: TelegramNotifyService,
    private readonly legal: LegalService,
  ) {}

  private cfg() {
    return loadConfiguration().billing;
  }

  /**
   * Прайс для экрана покупки (TMA `/pricing`, админка). Публичный маршрут
   * — цены не секрет, а без них фронтенду нечего показать до самого
   * чекаута. Источник истины — `billing-pricing.ts` (те же env-
   * переопределения, что читает и сам чекаут), здесь только форма ответа.
   */
  getPrices(locale: SupportedLocale = DEFAULT_LOCALE): {
    subscriptions: Record<
      'STANDARD' | 'PREMIUM',
      ReturnType<typeof subscriptionPriceFor>
    >;
    creditPacks: ReturnType<typeof creditPacks>;
  } {
    return {
      subscriptions: {
        STANDARD: subscriptionPriceFor('STANDARD'),
        PREMIUM: subscriptionPriceFor('PREMIUM'),
      },
      creditPacks: creditPacks(locale),
    };
  }

  // ── Старт покупки ─────────────────────────────────────────────────

  async startSubscriptionCheckout(
    userId: string,
    plan: 'STANDARD' | 'PREMIUM',
    method: PaymentMethodValue,
  ): Promise<CheckoutResult> {
    // Аудит 2026-09-08 (Г-6.4): акцепт оферты проверялся только перед
    // разбором (LegalService.assertAccepted в analysis.service.ts) — на
    // старте платного чекаута деньги принимались без единой проверки
    // согласия. Тот же гвард, тот же метод — согласие едино для всего
    // сервиса, не только для разборов.
    await this.legal.assertAccepted(userId);
    const price = subscriptionPriceFor(plan);
    const title = `Подписка ${plan} — месяц`;
    if (method === 'STARS') {
      this.assertStarsConfigured();
      const payload = signStarsInvoicePayload(
        { userId, purpose: 'SUBSCRIPTION', target: plan },
        this.cfg().paymentTokenKey,
      );
      const url = await this.stars.createInvoiceLink({
        title,
        description: `Ежемесячная подписка, автопродление через Telegram Stars`,
        payload,
        amount: price.stars,
        subscription: true,
      });
      return { starsInvoiceUrl: url };
    }
    this.assertWayForPayConfigured();
    const providerRef = randomUUID();
    await this.prisma.payment.create({
      data: {
        userId,
        method: 'WAYFORPAY',
        purpose: 'SUBSCRIPTION',
        plan,
        status: 'PENDING',
        currency: price.wayforpayCurrency,
        amount: price.wayforpayMinor,
        amountMicroUsd: estimateAmountMicroUsd(
          'WAYFORPAY',
          price.wayforpayMinor,
        ),
        providerRef,
      },
    });
    const form = this.wayforpay.buildPurchaseForm({
      orderReference: providerRef,
      amount: price.wayforpayMinor / 100,
      currency: price.wayforpayCurrency,
      productName: title,
      returnUrl: this.returnUrl(),
      serviceUrl: this.serviceUrl(),
    });
    return { wayforpayFormUrl: form.url, wayforpayFields: form.fields };
  }

  async startCreditPackCheckout(
    userId: string,
    packId: string,
    method: PaymentMethodValue,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): Promise<CheckoutResult> {
    // Аудит 2026-09-08 (Г-6.4) — см. комментарий в startSubscriptionCheckout.
    await this.legal.assertAccepted(userId);
    const pack = creditPackById(packId, locale);
    if (!pack) {
      throw new Error(`Неизвестный пакет кредитов: ${packId}`);
    }
    const title = `Пакет: ${pack.title}`;
    if (method === 'STARS') {
      this.assertStarsConfigured();
      const payload = signStarsInvoicePayload(
        { userId, purpose: 'CREDIT_PACK', target: pack.id },
        this.cfg().paymentTokenKey,
      );
      const url = await this.stars.createInvoiceLink({
        title,
        description: `${pack.credits} кредитов на генерацию ролика`,
        payload,
        amount: pack.stars,
      });
      return { starsInvoiceUrl: url };
    }
    this.assertWayForPayConfigured();
    const providerRef = randomUUID();
    await this.prisma.payment.create({
      data: {
        userId,
        method: 'WAYFORPAY',
        purpose: 'CREDIT_PACK',
        creditsGranted: pack.credits,
        status: 'PENDING',
        currency: pack.wayforpayCurrency,
        amount: pack.wayforpayMinor,
        amountMicroUsd: estimateAmountMicroUsd(
          'WAYFORPAY',
          pack.wayforpayMinor,
        ),
        providerRef,
      },
    });
    const form = this.wayforpay.buildPurchaseForm({
      orderReference: providerRef,
      amount: pack.wayforpayMinor / 100,
      currency: pack.wayforpayCurrency,
      productName: title,
      returnUrl: this.returnUrl(),
      serviceUrl: this.serviceUrl(),
    });
    return { wayforpayFormUrl: form.url, wayforpayFields: form.fields };
  }

  // ── Telegram: pre_checkout_query / successful_payment ───────────────

  async handleTelegramUpdate(update: TelegramUpdateBody): Promise<void> {
    if (update.pre_checkout_query) {
      await this.handlePreCheckout(update.pre_checkout_query);
      return;
    }
    const sp = update.message?.successful_payment;
    if (sp) {
      await this.handleStarsSuccess(sp);
    }
    // Любой другой тип апдейта (сообщение без платежа и т.п.) — молча
    // игнорируется: этот вебхук существует ТОЛЬКО ради платежей.
  }

  private async handlePreCheckout(query: {
    id: string;
    invoice_payload: string;
  }): Promise<void> {
    const payload = verifyStarsInvoicePayload(
      query.invoice_payload,
      this.cfg().paymentTokenKey,
    );
    if (!payload) {
      await this.stars.answerPreCheckoutQuery(
        query.id,
        false,
        'Ссылка на оплату устарела, начните покупку заново',
      );
      return;
    }
    if (payload.purpose === 'CREDIT_PACK' && !creditPackById(payload.target)) {
      await this.stars.answerPreCheckoutQuery(
        query.id,
        false,
        'Этот пакет больше не продаётся',
      );
      return;
    }
    await this.stars.answerPreCheckoutQuery(query.id, true);
  }

  private async handleStarsSuccess(sp: {
    telegram_payment_charge_id: string;
    invoice_payload: string;
    total_amount: number;
    is_recurring?: boolean;
  }): Promise<void> {
    // Г-2.1 (аудит round4): автопродление шлёт тот же payload, что и
    // первый платёж, — TTL в 30 минут рассчитан на ссылку одноразового
    // чекаута и не должен применяться к нему (см. комментарий у
    // `skipExpiry` в stars-invoice-payload.util.ts).
    const payload = verifyStarsInvoicePayload(
      sp.invoice_payload,
      this.cfg().paymentTokenKey,
      { skipExpiry: sp.is_recurring === true },
    );
    if (!payload) {
      // Деньги Telegram уже списал, а payload не наш/повреждён — это не
      // должно происходить при нормальной работе (подпись HMAC), но если
      // произошло, оператору нужно узнать, а не потерять платёж молча.
      await this.notify.alert(
        'billing:stars:bad-payload',
        `Успешный платёж Stars с нераспознанным payload: charge=${sp.telegram_payment_charge_id}`,
      );
      return;
    }
    // Г-2.5 (аудит round4): создание строки Payment и применение выгод
    // (леджер/подписка) — ОДНА транзакция под advisory-замком по
    // charge_id. Раньше это были два разных шага: если `applySuccessful
    // Payment` падал (P2002 на параллельной Stars+WFP-оплате, обрыв
    // соединения), Payment оставался SUCCEEDED, а ретрай Telegram ловил
    // P2002 на создании строки и молча выходил, ничего не применив
    // повторно — деньги получены, услуга не выдана. Теперь при сбое ВСЯ
    // транзакция откатывается (строка Payment исчезает вместе с ней), и
    // следующая доставка того же successful_payment проходит весь путь
    // заново с чистого листа — двойного начисления не будет: см.
    // `findUnique` в начале блока.
    const applied = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment:${sp.telegram_payment_charge_id}`}))`;
      const existing = await tx.payment.findUnique({
        where: {
          method_providerRef: {
            method: 'STARS',
            providerRef: sp.telegram_payment_charge_id,
          },
        },
      });
      if (existing) return ALREADY_PROCESSED; // уже полностью применено прежней транзакцией
      const payment = await tx.payment.create({
        data: {
          userId: payload.userId,
          method: 'STARS',
          purpose: payload.purpose,
          plan:
            payload.purpose === 'SUBSCRIPTION'
              ? (payload.target as PlanId)
              : null,
          creditsGranted:
            payload.purpose === 'CREDIT_PACK'
              ? (creditPackById(payload.target)?.credits ?? null)
              : null,
          status: 'SUCCEEDED',
          currency: 'XTR',
          amount: sp.total_amount,
          amountMicroUsd: estimateAmountMicroUsd('STARS', sp.total_amount),
          providerRef: sp.telegram_payment_charge_id,
        },
      });
      // Возвращает PlanId (продолжить `applyPurchasedPlan` после коммита)
      // или null (пакет кредитов — тут больше нечего делать).
      return this.applySuccessfulPayment(
        tx,
        payment,
        payload.purpose,
        payload.target,
        null,
      );
    });
    if (applied === ALREADY_PROCESSED) return; // повторная доставка — уже обработано
    if (applied) await this.plans.applyPurchasedPlan(payload.userId, applied);
    await this.notify.stat(
      `Оплата Stars: ${payload.purpose === 'SUBSCRIPTION' ? `подписка ${payload.target}` : `пакет ${payload.target}`}, ${sp.total_amount} XTR`,
    );
  }

  // ── WayForPay: вебхук ────────────────────────────────────────────

  async handleWayForPayWebhook(body: WayForPayWebhookBody): Promise<{
    orderReference: string;
    status: 'accept';
    time: number;
    signature: string;
  }> {
    const ack = this.wayforpay.buildWebhookAck(body.orderReference);
    if (!this.wayforpay.verifyServiceCallback(body)) {
      await this.notify.alert(
        'billing:wayforpay:bad-signature',
        `Вебхук WayForPay с неверной подписью: orderReference=${body.orderReference}`,
      );
      return ack; // квитанция отдаётся в любом случае — иначе провайдер зациклится на ретраях
    }
    const payment = await this.prisma.payment.findUnique({
      where: {
        method_providerRef: {
          method: 'WAYFORPAY',
          providerRef: body.orderReference,
        },
      },
    });
    if (!payment) {
      await this.notify.alert(
        'billing:wayforpay:unknown-order',
        `Вебхук WayForPay для неизвестного orderReference=${body.orderReference}`,
      );
      return ack;
    }
    if (payment.status !== 'PENDING') return ack; // повторная доставка — уже обработано

    if (body.transactionStatus !== 'Approved') {
      if (!TERMINAL_FAILURE_STATUSES.has(body.transactionStatus)) {
        // Г-2.4 (аудит round4): промежуточный статус — 3DS ожидает
        // подтверждения банком (`WaitingAuthComplete`), запрос ещё
        // обрабатывается (`InProcessing`) или просто `Pending`. Для
        // украинских карт 3DS — норма, не исключение. Платёж остаётся
        // PENDING: следующий вебхук (терминальный Approved/Declined/…)
        // обработает его как обычно; если бы мы пометили FAILED здесь,
        // позже пришедший Approved был бы отброшен строкой выше
        // (`payment.status !== 'PENDING'`) — оплаченный клиент навсегда
        // остался бы без подписки/кредитов.
        this.logger.log(
          `WayForPay промежуточный статус: orderReference=${body.orderReference}, ${body.transactionStatus} — платёж остаётся PENDING`,
        );
        return ack;
      }
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'FAILED',
          failureReason: `${body.transactionStatus} (${body.reasonCode})`,
          rawPayload: sanitizeWayForPayRawPayload(body),
        },
      });
      await this.notify.alert(
        'billing:wayforpay:declined',
        `Платёж WayForPay отклонён: orderReference=${body.orderReference}, ${body.transactionStatus}`,
      );
      return ack;
    }

    const recTokenEnc = body.recToken
      ? encryptToken(body.recToken, this.cfg().paymentTokenKey)
      : null;
    // Г-2.5/Г-2.6 (аудит round4): статус платежа и применение выгод — в
    // одной транзакции под advisory-замком по `orderReference`. Замок
    // заодно сериализует конкурентные доставки одного вебхука (WayForPay
    // ретраит агрессивно): вторая доставка видит `fresh.status !==
    // 'PENDING'` внутри той же транзакции и не начисляет повторно —
    // раньше `findUnique` вне транзакции оставлял окно между чтением и
    // `update`, в которое умещались обе параллельные доставки.
    const applied = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment:${body.orderReference}`}))`;
      const fresh = await tx.payment.findUnique({
        where: { id: payment.id },
      });
      if (!fresh || fresh.status !== 'PENDING') return ALREADY_PROCESSED;
      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'SUCCEEDED',
          rawPayload: sanitizeWayForPayRawPayload(body),
        },
      });
      return this.applySuccessfulPayment(
        tx,
        updated,
        payment.purpose as 'SUBSCRIPTION' | 'CREDIT_PACK',
        (payment.plan as string | null) ?? '',
        recTokenEnc,
      );
    });
    if (applied === ALREADY_PROCESSED) return ack; // конкурентная доставка уже обработала платёж
    if (applied) await this.plans.applyPurchasedPlan(payment.userId, applied);
    await this.notify.stat(
      `Оплата WayForPay: orderReference=${body.orderReference}, ${body.amount} ${body.currency}`,
    );
    return ack;
  }

  // ── Применение успешной оплаты (общее для обоих провайдеров) ────────

  /**
   * `tx` — клиент активной `$transaction` вызывающего (Г-2.5): статус
   * `Payment` и начисление/продление фиксируются атомарно, чтобы сбой
   * между ними не оставлял «оплачено, не выдано» навсегда.
   * `PlanService.applyPurchasedPlan` (User.plan) в транзакцию НЕ входит —
   * `PlanService` его не поддерживает, а денормализованный кэш режима на
   * `User` безопасно применить и после коммита (см. вызов у обоих
   * вызывающих через возвращаемый `plan`); финансовые записи
   * (`Subscription`/`CreditLedger`), которым нужна атомарность с
   * `Payment`, идут через `tx`.
   *
   * Возвращает `PlanId`, когда вызывающему нужно после коммита применить
   * его через `PlanService.applyPurchasedPlan`, иначе `null`.
   */
  private async applySuccessfulPayment(
    tx: Prisma.TransactionClient,
    payment: {
      id: string;
      userId: string;
      method: PaymentMethodValue;
      creditsGranted?: number | null;
    },
    purpose: 'SUBSCRIPTION' | 'CREDIT_PACK',
    planOrPackId: string,
    recTokenEnc: string | null,
  ): Promise<PlanId | null> {
    if (purpose === 'CREDIT_PACK') {
      // Число кредитов резолвится по каталогу и записывается на саму
      // строку `Payment` ещё в момент старта чекаута (и у Stars — в
      // `handleStarsSuccess`, и у WayForPay — в `startCreditPackCheckout`)
      // — здесь оно ЧИТАЕТСЯ, а не пересчитывается заново. Пересчёт по
      // `planOrPackId` был бы неверен для WayForPay: там это поле несёт
      // `Payment.plan`, которое для CREDIT_PACK всегда пусто, — то есть
      // кредиты за карточную оплату не начислялись бы никогда.
      if (!payment.creditsGranted) {
        this.logger.error(
          `Оплаченный пакет кредитов без сохранённого числа кредитов: payment=${payment.id}`,
        );
        return null;
      }
      await this.creditLedger.grant(
        payment.userId,
        payment.creditsGranted,
        payment.id,
        tx,
      );
      return null;
    }
    const plan = planOrPackId as PlanId;
    const periodEnd = new Date(
      Date.now() + SUBSCRIPTION_PERIOD_DAYS * 24 * 60 * 60 * 1000,
    );
    const existing = await tx.subscription.findUnique({
      where: { userId: payment.userId },
    });
    if (existing?.cancelAtPeriodEnd) {
      // Г-2.2 (аудит round4): пользователь (или оператор) уже запросил
      // отмену — эта подписка НЕ должна реанимироваться повторным
      // платежом. Для Stars такой платёж означает, что нотификация
      // Telegram (`TelegramStarsService.cancelSubscription`) либо ещё не
      // дошла, либо Telegram успел списать раньше неё — деньги уже
      // получены, но саму подписку не продлеваем и не сбрасываем
      // `cancelAtPeriodEnd`; кредитный пакет применился бы и так (эта
      // ветка — только SUBSCRIPTION, см. ранний `return` для CREDIT_PACK
      // выше). Логируем, чтобы оператор знал: Telegram, возможно, всё ещё
      // считает подписку активной и её стоит отменить вручную.
      this.logger.warn(
        `Оплата подписки после запроса отмены — подписка НЕ реанимирована: payment=${payment.id}, user=${payment.userId}`,
      );
      return null;
    }
    if (existing) {
      // Продление раньше срока (ранний ретрай или смена способа оплаты)
      // не должно ОТБИРАТЬ уже оплаченное время — берём максимум.
      const base =
        existing.currentPeriodEnd > new Date()
          ? existing.currentPeriodEnd
          : new Date();
      const extended = new Date(
        base.getTime() + SUBSCRIPTION_PERIOD_DAYS * 24 * 60 * 60 * 1000,
      );
      await tx.subscription.update({
        where: { userId: payment.userId },
        data: {
          plan,
          method: payment.method,
          status: 'ACTIVE',
          cancelAtPeriodEnd: false,
          currentPeriodEnd: extended,
          ...(recTokenEnc ? { recTokenEnc } : {}),
          payments: { connect: { id: payment.id } },
        },
      });
    } else {
      await tx.subscription.create({
        data: {
          userId: payment.userId,
          plan,
          method: payment.method,
          status: 'ACTIVE',
          currentPeriodEnd: periodEnd,
          recTokenEnc,
          payments: { connect: { id: payment.id } },
        },
      });
    }
    return plan;
  }

  private returnUrl(): string {
    return `${loadConfiguration().publishing.tmaUrl.replace(/\/+$/, '')}?billingReturn=1`;
  }

  private serviceUrl(): string {
    return `${loadConfiguration().publishing.apiPublicUrl.replace(/\/+$/, '')}/billing/webhook/wayforpay`;
  }

  private assertStarsConfigured(): void {
    if (!this.stars.configured()) {
      throw new ServiceUnavailableException(
        'TELEGRAM_BOT_TOKEN не задан — оплата через Stars недоступна',
      );
    }
  }

  private assertWayForPayConfigured(): void {
    if (!this.wayforpay.configured()) {
      throw new ServiceUnavailableException(
        'WayForPay не настроен — оплата картой недоступна',
      );
    }
  }
}
