/**
 * WayForPayRenewalService — продление подписки картой по сохранённому
 * `recToken` (ТЗ §41.2, этап 62). Настоящее инициируемое СЕРВЕРОМ
 * списание (host2host `Charge`, `wayforpay.service.ts`) — в отличие от
 * Stars, где продлевает сам Telegram (см.
 * `stars-subscription-reconcile.service.ts`).
 *
 * Грейс-период вместо счётчика попыток: крон продления дневной (не
 * раз в 1-2 минуты, как у `/cron/publish`), значит естественный интервал
 * между попытками уже сутки — отдельный backoff поверх этого был бы
 * избыточен. `currentPeriodEnd` НЕ трогается при неудаче — он же служит
 * якорем «с какого момента считать грейс»: следующий тик увидит ту же
 * просроченную строку и попробует снова, пока не истечёт
 * `GRACE_PERIOD_DAYS`.
 *
 * ## Идемпотентность списания (Г-2.7 аудита round4, этап 64)
 *
 * Раньше `orderReference` генерировался случайным `randomUUID()` в
 * момент запуска, а строка `Payment` создавалась ПОСЛЕ ответа
 * `chargeRecToken`. Если функция падала/таймаутила МЕЖДУ успешным
 * списанием и записью результата (Vercel убивает функцию по таймауту
 * без гарантии, что код после `await` дойдёт до конца), эта попытка не
 * оставляла никакого следа — следующий суточный тик видел ту же
 * просроченную подписку и списывал ещё раз. Отдельно: два одновременных
 * прогона (ручной `curl` + сам крон, или два инстанса Vercel) читали
 * один и тот же список без блокировки и оба списывали с карты.
 *
 * Теперь: (1) атомарный claim (`updateMany` по `id` + СНИМКУ
 * `currentPeriodEnd`, которого не касается только один прогон, RENEWING
 * ставится ДО списания) закрывает второй сценарий; (2) детерминированный
 * `orderReference = sub:<id>:<periodEnd>` и PENDING-строка `Payment`,
 * заведённая ДО вызова `chargeRecToken`, закрывают первый — при ретрае
 * (после сбоя) `orderReference` будет ТЕМ ЖЕ, и WayForPay дедуплицирует
 * повторный запрос с уже виденным `orderReference` вместо второго
 * реального списания.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { WayForPayService } from '../billing/wayforpay.service';
import { decryptToken, encryptToken } from '../../common/token-crypto';
import { subscriptionPriceFor } from '../../common/billing-pricing';
import { sanitizeWayForPayRawPayload } from '../../common/wayforpay-sanitize';
import { loadConfiguration } from '../../config/configuration';
import { PlanId } from '../../common/plans';

const SUBSCRIPTION_PERIOD_DAYS = 30;
/** Сколько суток продолжаем пробовать списать, прежде чем сдаться и
 * понизить до LITE (§41, открытый вопрос — точное число не решение
 * владельца продукта, разумный дефолт). */
const GRACE_PERIOD_DAYS = 3;
/** Предохранитель против вечно застрявшего RENEWING (Г-2.7): если сам
 * процесс упал посреди списания (а не просто вернул ошибку — тот случай
 * ловится `try/catch` ниже и статус освобождается штатно), строка не
 * должна голодать вечно — час явно больше любого одиночного HTTP-вызова
 * к WayForPay, но много меньше суточного шага крона, так что повторный
 * тик того же дня её не подхватит, а следующий — подхватит. */
const STALE_CLAIM_MS = 60 * 60 * 1000;

interface RenewableSubscription {
  id: string;
  userId: string;
  plan: string;
  currentPeriodEnd: Date;
  recTokenEnc: string | null;
}

export type RenewalOutcome = 'renewed' | 'past_due' | 'canceled';

@Injectable()
export class WayForPayRenewalService {
  private readonly logger = new Logger(WayForPayRenewalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly wayforpay: WayForPayService,
  ) {}

  async charge(subscription: RenewableSubscription): Promise<RenewalOutcome> {
    if (!subscription.recTokenEnc) {
      // Подписка WayForPay без recToken — мерчант-аккаунт не был на
      // regular payments в момент покупки (§41, открытый вопрос 2).
      // Продлить нечем, ведём себя как при исчерпанном грейсе сразу.
      return this.giveUp(subscription);
    }

    // Claim-before-charge (Г-2.7): атомарно захватываем строку по её
    // СНИМКУ currentPeriodEnd — если её уже захватил другой прогон
    // (RENEWING и не устарел), просто отступаем на этот тик, ничего не
    // списывая; следующий тик решит.
    const claimed = await this.prisma.subscription.updateMany({
      where: {
        id: subscription.id,
        currentPeriodEnd: subscription.currentPeriodEnd,
        OR: [
          { status: { not: 'RENEWING' } },
          { updatedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } },
        ],
      },
      data: { status: 'RENEWING' },
    });
    if (claimed.count === 0) {
      this.logger.log(
        `Подписка ${subscription.id} уже захвачена другим прогоном продления — пропуск`,
      );
      return 'past_due';
    }

    const overdueDays =
      (Date.now() - subscription.currentPeriodEnd.getTime()) /
      (24 * 60 * 60 * 1000);
    let recToken: string;
    try {
      recToken = decryptToken(
        subscription.recTokenEnc,
        loadConfiguration().billing.paymentTokenKey,
      );
    } catch (error) {
      this.logger.error(
        `Не удалось расшифровать recToken подписки ${subscription.id}: ${String(error)}`,
      );
      return overdueDays > GRACE_PERIOD_DAYS
        ? this.giveUp(subscription)
        : this.markPastDue(subscription.id);
    }

    const price = subscriptionPriceFor(
      subscription.plan as Extract<PlanId, 'STANDARD' | 'PREMIUM'>,
    );
    // Детерминированный, а не случайный: тот же самый periodEnd при
    // ретрае (после сбоя ДО того, как currentPeriodEnd успел сдвинуться)
    // даёт тот же orderReference — WayForPay видит повтор и не спишет
    // дважды.
    const orderReference = `sub:${subscription.id}:${subscription.currentPeriodEnd.getTime()}`;
    // PENDING-строка ДО списания — если процесс упадёт между вызовом
    // WayForPay и записью результата, строка уже существует и следующий
    // ретрай найдёт её по тому же orderReference вместо создания новой.
    const payment = await this.prisma.payment.upsert({
      where: {
        method_providerRef: {
          method: 'WAYFORPAY',
          providerRef: orderReference,
        },
      },
      create: {
        userId: subscription.userId,
        method: 'WAYFORPAY',
        purpose: 'SUBSCRIPTION',
        plan: subscription.plan as PlanId,
        status: 'PENDING',
        currency: price.wayforpayCurrency,
        amount: price.wayforpayMinor,
        providerRef: orderReference,
        subscriptionId: subscription.id,
      },
      update: {}, // уже существует — предыдущая попытка того же периода, переиспользуем строку
    });

    let result;
    try {
      result = await this.wayforpay.chargeRecToken({
        recToken,
        orderReference,
        amount: price.wayforpayMinor / 100,
        currency: price.wayforpayCurrency,
        productName: `Подписка ${subscription.plan} — продление`,
      });
    } catch (error) {
      this.logger.warn(
        `Продление ${subscription.id} не удалось (сеть/API): ${String(error)}`,
      );
      // Payment остаётся PENDING — следующий ретрай переиспользует ту же
      // строку и тот же orderReference (см. upsert выше).
      return overdueDays > GRACE_PERIOD_DAYS
        ? this.giveUp(subscription)
        : this.markPastDue(subscription.id);
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: result.ok ? 'SUCCEEDED' : 'FAILED',
        rawPayload: sanitizeWayForPayRawPayload(result.rawPayload),
        failureReason: result.ok ? null : result.transactionStatus,
      },
    });

    if (!result.ok) {
      return overdueDays > GRACE_PERIOD_DAYS
        ? this.giveUp(subscription)
        : this.markPastDue(subscription.id);
    }

    const extended = new Date(
      Date.now() + SUBSCRIPTION_PERIOD_DAYS * 24 * 60 * 60 * 1000,
    );
    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'ACTIVE',
        currentPeriodEnd: extended,
        ...(result.recToken
          ? {
              recTokenEnc: encryptToken(
                result.recToken,
                loadConfiguration().billing.paymentTokenKey,
              ),
            }
          : {}),
      },
    });
    return 'renewed';
  }

  private async markPastDue(subscriptionId: string): Promise<RenewalOutcome> {
    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: 'PAST_DUE' },
    });
    return 'past_due';
  }

  private async giveUp(
    subscription: RenewableSubscription,
  ): Promise<RenewalOutcome> {
    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: 'CANCELED' },
    });
    await this.plans.applyPurchasedPlan(subscription.userId, 'LITE');
    this.logger.log(
      `Подписка ${subscription.id} отменена (грейс исчерпан) — пользователь ${subscription.userId} переведён на LITE`,
    );
    return 'canceled';
  }
}
