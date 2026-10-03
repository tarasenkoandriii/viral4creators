/**
 * Чтение для монитора Т-4 и экрана кабинета (Э6-бис (г), §5-бис.10,
 * §5-бис.14) — основной ролью с тенантом кабинета: планы окна БЕЗ тестовых
 * сессий мастера (`voiceTestId IS NULL` — сухие прогоны и проверка владельца
 * в метрики не идут) и журнал шагов тех же планов. Числа — `computeMetrics`.
 */
import type { Prisma } from '@prisma/client';
import {
  computeMetrics,
  MONITOR_THRESHOLDS,
  type MonitorLogRow,
  type MonitorPlanRow,
  type SiteVoiceMetrics,
} from '../monitor-rules';

export interface MonitorDb {
  assistSiteUiPlan: {
    findMany(args: {
      where: Prisma.AssistSiteUiPlanWhereInput;
      select: Record<string, true>;
      orderBy?: Prisma.AssistSiteUiPlanOrderByWithRelationInput;
      take?: number;
    }): Promise<unknown[]>;
  };
  assistSiteUiActionLog: {
    findMany(args: {
      where: Prisma.AssistSiteUiActionLogWhereInput;
      select: Record<string, true>;
      take?: number;
    }): Promise<unknown[]>;
  };
}

/** Строки окна: планы (с выпуском — для канарейки) и их журнал. */
export async function loadWindow(
  db: MonitorDb,
  where: { siteId?: string; since: Date; release?: string | null },
): Promise<{ plans: MonitorPlanRow[]; logs: MonitorLogRow[] }> {
  const planWhere: Prisma.AssistSiteUiPlanWhereInput = {
    createdAt: { gte: where.since },
    voiceTestId: null,
    ...(where.siteId ? { siteId: where.siteId } : {}),
    ...(where.release !== undefined ? { release: where.release } : {}),
  };
  const plans = (await db.assistSiteUiPlan.findMany({
    where: planWhere,
    select: {
      id: true,
      visitorId: true,
      status: true,
      confirmedBy: true,
      createdAt: true,
      release: true,
      steps: true,
      chainStatus: true,
    },
    orderBy: { createdAt: 'desc' },
    take: MONITOR_THRESHOLDS.logRowsPerSite,
  })) as MonitorPlanRow[];
  if (!plans.length) return { plans, logs: [] };
  const logs = (await db.assistSiteUiActionLog.findMany({
    where: {
      planId: { in: plans.map((p) => p.id) },
      ...(where.siteId ? { siteId: where.siteId } : {}),
    },
    select: {
      planId: true,
      stepIndex: true,
      action: true,
      result: true,
      reason: true,
      createdAt: true,
    },
    take: MONITOR_THRESHOLDS.logRowsPerSite,
  })) as MonitorLogRow[];
  return { plans, logs };
}

export async function siteMetrics(
  db: MonitorDb,
  siteId: string,
  now: Date,
): Promise<SiteVoiceMetrics> {
  const w = await loadWindow(db, {
    siteId,
    since: new Date(now.getTime() - MONITOR_THRESHOLDS.windowMs),
  });
  return computeMetrics(w.plans, w.logs);
}
