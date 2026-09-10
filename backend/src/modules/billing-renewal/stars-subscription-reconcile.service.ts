/**
 * StarsSubscriptionReconcileService — сверка подписок Stars (ТЗ §41.2,
 * этап 62).
 *
 * У Stars НЕТ `recToken`-эквивалента: продление делает сам Telegram
 * (родной `subscription_period` в `createInvoiceLink`) и сам присылает
 * новый `successful_payment` в вебхук — наш сервер не может списать
 * Stars по своей инициативе, это ограничение платформы, не пробел
 * реализации. Роль этого класса — не списание, а СВЕРКА: если подписка
 * просрочена дольше грейс-периода, а ожидаемого вебхука-продления так и
 * не пришло (иначе `currentPeriodEnd` уже был бы сдвинут в будущее
 * обработчиком `successful_payment`), значит у Telegram не хватило Stars
 * на автосписание — переводим в PAST_DUE, а после грейса — в CANCELED.
 *
 * ## Снимок вместо безусловной записи (Е-1.1 шестого аудита, этап 76)
 *
 * `subscription` — снимок строки, прочитанный воркером в начале тика
 * (`findMany` без блокировки). Между этим чтением и записью ниже может
 * прийти задержанный вебхук `successful_payment` и реально продлить
 * подписку (сдвинуть `currentPeriodEnd` вперёд) — без проверки снимка
 * `reconcile()` затёр бы этот только что оплаченный статус устаревшим
 * PAST_DUE/CANCELED. Условие `currentPeriodEnd: subscription.currentPeriodEnd`
 * в `updateMany` — тот же приём, что у `WayForPayRenewalService.charge()`
 * (claim-before-charge, Г-2.7 round4): если реальная строка в БД уже не
 * совпадает со снимком, `count === 0` и мы ничего не трогаем — тик
 * просто отступает, следующий увидит уже актуальный (ACTIVE) статус и
 * не будет вызван вовсе (сверке подлежат только реально просроченные
 * строки, см. выборку в `billing-renewal-worker.service.ts`).
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';

/** Тот же грейс, что у WayForPay — согласованное поведение независимо от
 * способа оплаты (§41, открытый вопрос — разумный дефолт). */
const GRACE_PERIOD_DAYS = 3;

interface ReconcilableSubscription {
  id: string;
  userId: string;
  currentPeriodEnd: Date;
}

export type ReconcileOutcome = 'past_due' | 'canceled';

@Injectable()
export class StarsSubscriptionReconcileService {
  private readonly logger = new Logger(StarsSubscriptionReconcileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  async reconcile(
    subscription: ReconcilableSubscription,
  ): Promise<ReconcileOutcome> {
    const overdueDays =
      (Date.now() - subscription.currentPeriodEnd.getTime()) /
      (24 * 60 * 60 * 1000);
    if (overdueDays <= GRACE_PERIOD_DAYS) {
      const updated = await this.prisma.subscription.updateMany({
        where: {
          id: subscription.id,
          currentPeriodEnd: subscription.currentPeriodEnd,
        },
        data: { status: 'PAST_DUE' },
      });
      if (updated.count === 0) {
        this.logger.log(
          `Подписка Stars ${subscription.id} уже продлена вебхуком между чтением снимка и сверкой — PAST_DUE не применён`,
        );
      }
      return 'past_due';
    }
    const updated = await this.prisma.subscription.updateMany({
      where: {
        id: subscription.id,
        currentPeriodEnd: subscription.currentPeriodEnd,
      },
      data: { status: 'CANCELED' },
    });
    if (updated.count === 0) {
      this.logger.log(
        `Подписка Stars ${subscription.id} уже продлена вебхуком между чтением снимка и сверкой — отмена не применена`,
      );
      return 'past_due';
    }
    await this.plans.applyPurchasedPlan(subscription.userId, 'LITE');
    this.logger.log(
      `Подписка Stars ${subscription.id} отменена (продление не пришло) — пользователь ${subscription.userId} переведён на LITE`,
    );
    return 'canceled';
  }
}
