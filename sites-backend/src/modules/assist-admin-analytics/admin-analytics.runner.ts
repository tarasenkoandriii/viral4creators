/**
 * Оркестратор аналитики «Админки» в существующем кроне
 * `assist-admin-embed-run` (раз в 2 мин; Vercel Hobby — без нового крона,
 * Р-З10-13):
 *  - каждый тик — выгрузки CSV (дёшево, когда очереди нет; владелец ждёт
 *    файл минуты, а не десятки минут);
 *  - не чаще раза в `ADMIN_ANALYTICS_THROTTLE_MS` (10 мин) — тревога
 *    компенсаций (push), разметка диалогов, суточная свёртка, неделя
 *    (выводы и отчёт);
 *  - раз в сутки — уборка старых свёрток, выводов и журнала выгрузок. Троттлинг — замок `site_cron_locks` с TTL 10 мин,
 *    который НЕ снимается: часы базы, а не инстанса, и второй инстанс в том
 *    же окне не пройдёт.
 * Сбой одной части не роняет другие (и индексацию в том же кроне).
 */
import { Injectable, Logger } from '@nestjs/common';
import { tryAcquireCronLock } from '../../common/cron-job-lock';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type AdminAlertTickResult,
  AdminCompensationAlerts,
} from './admin-alerts.service';
import { AdminExports } from './admin-exports.service';
import {
  type AdminLabelTickResult,
  AdminLabeler,
} from './admin-labeler.service';
import { AdminRollup } from './admin-rollup.service';
import {
  type AdminWeeklyTickResult,
  AdminWeekly,
} from './admin-weekly.service';

export const ADMIN_ANALYTICS_JOB = 'assist-admin-analytics';
export const ADMIN_ANALYTICS_THROTTLE_MS = 10 * 60 * 1000;
export const ADMIN_ANALYTICS_DAILY_JOB = 'assist-admin-analytics-daily';
export const ADMIN_ANALYTICS_DAILY_MS = 24 * 60 * 60 * 1000;
export const ADMIN_LABELS_PER_TICK = 30;
export const ADMIN_WEEKLY_SITES_PER_TICK = 5;
export const ADMIN_EXPORTS_PER_TICK = 2;

export interface AdminAnalyticsRunResult {
  exports: { done: number; failed: number; expired: number } | null;
  throttled: boolean;
  alerts: AdminAlertTickResult | null;
  rollup: { sites: number; extraDays: number } | null;
  /** Уборка раз в сутки; null — не в этот проход. */
  purged?: { dailyStats: number; insights: number; exports: number } | null;
  labels: AdminLabelTickResult | null;
  weekly: AdminWeeklyTickResult | null;
}

@Injectable()
export class AdminAnalyticsRunner {
  private readonly logger = new Logger(AdminAnalyticsRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly exportsSvc: AdminExports,
    private readonly alerts: AdminCompensationAlerts,
    private readonly rollup: AdminRollup,
    private readonly labeler: AdminLabeler,
    private readonly weekly: AdminWeekly,
  ) {}

  private async part<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      this.logger.error(
        `аналитика «Админки», ${name}: ${(e as Error | null)?.name ?? 'Error'}`,
      );
      return null;
    }
  }

  /**
   * `deadline` — граница времени тика (мс эпохи); `siteIds` — только тесты
   * на общей базе (как CronScope «Сайта»).
   */
  async run(
    now: Date,
    deadline: number,
    siteIds?: string[] | null,
  ): Promise<AdminAnalyticsRunResult> {
    const out: AdminAnalyticsRunResult = {
      exports: null,
      throttled: false,
      alerts: null,
      rollup: null,
      labels: null,
      weekly: null,
    };
    out.exports = await this.part('выгрузки', () =>
      this.exportsSvc.process(ADMIN_EXPORTS_PER_TICK, now, siteIds),
    );
    const holder = await this.part('троттлинг', () =>
      tryAcquireCronLock(
        this.prisma,
        siteIds?.length
          ? `${ADMIN_ANALYTICS_JOB}:${siteIds.join(',')}`.slice(0, 200)
          : ADMIN_ANALYTICS_JOB,
        ADMIN_ANALYTICS_THROTTLE_MS,
      ),
    );
    if (!holder) {
      out.throttled = true;
      return out;
    }
    // Замок НЕ снимается: он и есть «не чаще раза в 10 мин».
    out.alerts = await this.part('тревога компенсаций', () =>
      this.alerts.tick({ now, deadline, siteIds }),
    );
    // Разметка — ДО свёртки (метки этого прохода попадают в неё сразу) и не
    // дольше 60% остатка: свёртке и неделе время остаётся.
    const labelsDeadline =
      Date.now() + Math.max(0, Math.floor((deadline - Date.now()) * 0.6));
    out.labels = await this.part('разметка', () =>
      this.labeler.tick({
        now,
        deadline: labelsDeadline,
        max: ADMIN_LABELS_PER_TICK,
        siteIds,
      }),
    );
    out.rollup = await this.part('свёртка', () =>
      this.rollup.tick({ now, deadline, siteIds }),
    );
    out.weekly = await this.part('неделя', () =>
      this.weekly.tick({
        now,
        deadline,
        maxSites: ADMIN_WEEKLY_SITES_PER_TICK,
        siteIds,
      }),
    );
    // P3 (4): уборка старых свёрток, выводов и журнала выгрузок — раз в
    // сутки (тот же приём: замок на 24 ч без снятия).
    const daily = await this.part('уборка: замок', () =>
      tryAcquireCronLock(
        this.prisma,
        siteIds?.length
          ? `${ADMIN_ANALYTICS_DAILY_JOB}:${siteIds.join(',')}`.slice(0, 200)
          : ADMIN_ANALYTICS_DAILY_JOB,
        ADMIN_ANALYTICS_DAILY_MS,
      ),
    );
    if (daily) {
      out.purged = await this.part('уборка', async () => ({
        dailyStats: await this.rollup.purge(now, siteIds),
        insights: await this.weekly.purge(now, siteIds),
        exports: await this.exportsSvc.purgeJournal(now, siteIds),
      }));
    }
    return out;
  }
}
