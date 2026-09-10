/**
 * BillingRenewalWorkerService — крон-воркер продления подписок (этап 62,
 * ТЗ §41.4). Вызывается `GET /api/cron/billing-renew` раз в сутки
 * (`backend/vercel.json`) — точность в часы не нужна, продление
 * помесячное; в отличие от `/cron/publish`, укладывается в лимиты Vercel
 * Hobby.
 *
 * Один прогон (`runBatch`) берёт до `billing.cronBatch` подписок с
 * `currentPeriodEnd <= now()` и обрабатывает их по одной — ветвясь на три
 * случая: пользователь попросил отмену (`cancelAtPeriodEnd`), WayForPay
 * (настоящее списание) или Stars (сверка, не списание — см.
 * `stars-subscription-reconcile.service.ts`).
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { loadConfiguration } from '../../config/configuration';
import { WayForPayRenewalService } from './wayforpay-renewal.service';
import { StarsSubscriptionReconcileService } from './stars-subscription-reconcile.service';
import { tryAcquireJobLock, releaseJobLock } from '../../common/cron-job-lock';

const JOB_KEY = 'billing-renew';

interface DueSubscription {
  id: string;
  userId: string;
  plan: string;
  method: 'STARS' | 'WAYFORPAY';
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  recTokenEnc: string | null;
}

export interface RenewalBatchResult {
  processed: number;
  renewed: number;
  canceled: number;
  pastDue: number;
}

@Injectable()
export class BillingRenewalWorkerService {
  private readonly logger = new Logger(BillingRenewalWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly wayforpayRenewal: WayForPayRenewalService,
    private readonly starsReconcile: StarsSubscriptionReconcileService,
  ) {}

  async runBatch(): Promise<RenewalBatchResult> {
    // Джоб-уровневый замок (Е-1.3 шестого аудита, рецидив класса Д-3.3):
    // до этого фикса только три других крон-воркера (catalog-batch-run/
    // ab-test-run/feed-import-run) его получили — этот доступен из той же
    // вкладки «Кроны» под тем же лимитом и подвержен тому же риску
    // (двойной клик оператора, совпадение с расписанием Vercel Cron),
    // расширяя и окно гонки Е-1.1. Тот же приём: тихий пропуск тика, а не
    // соревнование с уже идущим прогоном построчно.
    const acquired = await tryAcquireJobLock(this.prisma, JOB_KEY);
    if (!acquired) {
      this.logger.warn(
        'Крон продления подписок: пропуск тика — другой прогон этого же джоба ещё выполняется',
      );
      return { processed: 0, renewed: 0, canceled: 0, pastDue: 0 };
    }
    try {
      return await this.runBatchLocked();
    } finally {
      await releaseJobLock(this.prisma, JOB_KEY);
    }
  }

  private async runBatchLocked(): Promise<RenewalBatchResult> {
    const rows: DueSubscription[] = await this.prisma.subscription.findMany({
      where: {
        currentPeriodEnd: { lte: new Date() },
        status: { not: 'CANCELED' },
      },
      orderBy: { currentPeriodEnd: 'asc' },
      take: loadConfiguration().billing.cronBatch,
    });

    let renewed = 0;
    let canceled = 0;
    let pastDue = 0;
    for (const row of rows) {
      try {
        if (row.cancelAtPeriodEnd) {
          // Пользователь запросил отмену через PATCH /api/me/plan —
          // доступ был до конца ОПЛАЧЕННОГО периода, а он только что
          // истёк. Никакого списания — просто фиксируем конец подписки.
          await this.prisma.subscription.update({
            where: { id: row.id },
            data: { status: 'CANCELED' },
          });
          await this.plans.applyPurchasedPlan(row.userId, 'LITE');
          canceled += 1;
          continue;
        }
        const outcome =
          row.method === 'WAYFORPAY'
            ? await this.wayforpayRenewal.charge(row)
            : await this.starsReconcile.reconcile(row);
        if (outcome === 'renewed') renewed += 1;
        else if (outcome === 'canceled') canceled += 1;
        else pastDue += 1;
      } catch (error) {
        this.logger.error(
          `Продление подписки ${row.id} упало неожиданно: ${String(error)}`,
        );
      }
    }
    const result: RenewalBatchResult = {
      processed: rows.length,
      renewed,
      canceled,
      pastDue,
    };
    if (rows.length > 0) {
      this.logger.log(
        `Крон продления подписок: обработано ${result.processed}, продлено ${result.renewed}, ` +
          `отменено ${result.canceled}, ждут повтора ${result.pastDue}`,
      );
    }
    return result;
  }
}
