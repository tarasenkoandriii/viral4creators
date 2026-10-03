/**
 * Бюджет аналитики с ИИ (Э3-бис; ТЗ §5-тер.17, Р-50, Р-58) — системный код,
 * основная роль. Два потолка, оба — РЕЗЕРВ ДО вызова модели:
 *  1. месячный потолок сайта: `ASSIST_PLANS[тариф].analyticsBudgetMicroUsd`
 *     подписки, поровну между сайтами кабинета с помощником (как бюджет
 *     обучения без явных долей); строка assist_analytics_spend (сайт, месяц);
 *  2. суточный потолок платформы: строка assist_budget_days
 *     scope='analytics', key='all' (env ASSIST_ANALYTICS_PLATFORM_DAILY_USD).
 * Резерв — ОДНА транзакция: условный UPDATE сайта, затем платформы
 * (порядок блокировок один — сайт, потом платформа); 0 строк у любого —
 * откат, отказ. После вызова — поправка на факт (settle) у обоих.
 *
 * Почему условный UPDATE, а не «прочитал-решил»: два тика крона (Vercel
 * может запустить повтор) не должны оба пройти по старому остатку.
 * Исчерпан потолок сайта → разметка переходит на выборку (§5-тер.3) и
 * затем останавливается до нового месяца; находки кодом идут всегда.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ASSIST_PLANS } from '../../assist-billing/plans';
import { readState } from '../../assist-billing/public/entitlements';
import { siteShareMicroUsd } from '../../site-ai/learning-budget';
import { platformDailyCapMicroUsd } from './ai-env';

export const ANALYTICS_PLATFORM_SCOPE = 'analytics';
const PLATFORM_KEY = 'all';

export type ReserveResult = 'ok' | 'site' | 'platform';

export interface AnalyticsReservation {
  accountId: string;
  siteId: string;
  period: string;
  day: string;
  est: number;
}

export interface AnalyticsBudgetStatus {
  period: string;
  capMicroUsd: number;
  spentMicroUsd: number;
}

class Denied extends Error {
  constructor(readonly kind: 'site' | 'platform') {
    super(kind);
  }
}

export function analyticsPeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}

@Injectable()
export class AnalyticsBudget {
  env: NodeJS.ProcessEnv = process.env;

  constructor(private readonly prisma: PrismaService) {}

  /** Доля сайта в месячном потолке подписки (0 — тарифа нет / без бюджета). */
  async siteCap(accountId: string, siteId: string, now: Date): Promise<number> {
    const state = await readState(this.prisma, accountId, now);
    const cap = state.planId
      ? ASSIST_PLANS[state.planId].analyticsBudgetMicroUsd
      : 0;
    if (cap <= 0) return 0;
    const rows = await this.prisma.$queryRawUnsafe<Array<{ siteId: string }>>(
      `SELECT "siteId" FROM "sites"."assist_sites"
        WHERE "accountId" = $1 AND ("enabled" OR "siteId" = $2)`,
      accountId,
      siteId,
    );
    return siteShareMicroUsd(
      cap,
      siteId,
      rows.map((r) => ({ siteId: r.siteId, learningShareBp: null })),
    );
  }

  async status(
    accountId: string,
    siteId: string,
    now: Date,
  ): Promise<AnalyticsBudgetStatus> {
    const period = analyticsPeriod(now);
    const [cap, rows] = await Promise.all([
      this.siteCap(accountId, siteId, now),
      this.prisma.$queryRawUnsafe<Array<{ spent: bigint }>>(
        `SELECT "spentMicroUsd" AS spent FROM "sites"."assist_analytics_spend"
          WHERE "siteId" = $1 AND "accountId" = $2 AND "period" = $3`,
        siteId,
        accountId,
        period,
      ),
    ]);
    return {
      period,
      capMicroUsd: cap,
      spentMicroUsd: Number(rows[0]?.spent ?? 0),
    };
  }

  /**
   * Резерв оценки у сайта и платформы. `capMicroUsd` — уже посчитанная доля
   * сайта (крон считает её раз на сайт за тик).
   */
  async reserve(
    accountId: string,
    siteId: string,
    estMicroUsd: number,
    capMicroUsd: number,
    now: Date,
  ): Promise<{
    result: ReserveResult;
    reservation: AnalyticsReservation | null;
  }> {
    const est = Math.max(1, Math.ceil(estMicroUsd));
    const period = analyticsPeriod(now);
    const day = now.toISOString().slice(0, 10);
    const platformCap = platformDailyCapMicroUsd(this.env);
    if (est > capMicroUsd) return { result: 'site', reservation: null };
    if (est > platformCap) return { result: 'platform', reservation: null };
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "sites"."assist_analytics_spend"
             ("accountId", "siteId", "period", "spentMicroUsd", "updatedAt")
           VALUES ($1, $2, $3, 0, now()) ON CONFLICT DO NOTHING`,
          accountId,
          siteId,
          period,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "sites"."assist_budget_days" ("scope", "key", "day", "updatedAt")
           VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`,
          ANALYTICS_PLATFORM_SCOPE,
          PLATFORM_KEY,
          day,
        );
        const s = await tx.$executeRawUnsafe(
          `UPDATE "sites"."assist_analytics_spend"
              SET "spentMicroUsd" = "spentMicroUsd" + $4, "updatedAt" = now()
            WHERE "siteId" = $1 AND "accountId" = $2 AND "period" = $3
              AND "spentMicroUsd" + $4 <= $5`,
          siteId,
          accountId,
          period,
          est,
          capMicroUsd,
        );
        if (s !== 1) throw new Denied('site');
        const p = await tx.$executeRawUnsafe(
          `UPDATE "sites"."assist_budget_days"
              SET "spentMicroUsd" = "spentMicroUsd" + $4, "updatedAt" = now()
            WHERE "scope" = $1 AND "key" = $2 AND "day" = $3
              AND "spentMicroUsd" + "reservedMicroUsd" + $4 <= $5`,
          ANALYTICS_PLATFORM_SCOPE,
          PLATFORM_KEY,
          day,
          est,
          platformCap,
        );
        if (p !== 1) throw new Denied('platform');
      });
    } catch (e) {
      if (e instanceof Denied) return { result: e.kind, reservation: null };
      throw e;
    }
    return {
      result: 'ok',
      reservation: { accountId, siteId, period, day, est },
    };
  }

  /** Поправка резерва на факт у сайта и платформы (не ниже нуля). */
  async settle(r: AnalyticsReservation, actualMicroUsd: number): Promise<void> {
    const delta = Math.round(actualMicroUsd) - r.est;
    if (delta === 0 || !Number.isFinite(delta)) return;
    await this.prisma.$executeRawUnsafe(
      `UPDATE "sites"."assist_analytics_spend"
          SET "spentMicroUsd" = GREATEST(0, "spentMicroUsd" + $4), "updatedAt" = now()
        WHERE "siteId" = $1 AND "accountId" = $2 AND "period" = $3`,
      r.siteId,
      r.accountId,
      r.period,
      delta,
    );
    await this.prisma.$executeRawUnsafe(
      `UPDATE "sites"."assist_budget_days"
          SET "spentMicroUsd" = GREATEST(0, "spentMicroUsd" + $4), "updatedAt" = now()
        WHERE "scope" = $1 AND "key" = $2 AND "day" = $3`,
      ANALYTICS_PLATFORM_SCOPE,
      PLATFORM_KEY,
      r.day,
      delta,
    );
  }
}
