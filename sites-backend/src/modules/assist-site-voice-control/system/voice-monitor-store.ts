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
      // У строки `plan` — хеш IP плана (потолок вклада, аудит (г) (3)).
      target: true,
    },
    take: MONITOR_THRESHOLDS.logRowsPerSite,
  })) as MonitorLogRow[];
  return { plans, logs };
}

export interface RawDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

const PLANS = '"sites"."assist_site_ui_plans"';
const LOG = '"sites"."assist_site_ui_action_log"';
const COUNTERS = '"sites"."assist_daily_counters"';

/**
 * (заход 9, аудит (г) (2)) Канарейка выпуска — АГРЕГАТЫ SQL по выпуску
 * вместо выборки строк (раньше ≤ 20 000 планов и строк журнала по
 * платформе: при росте нарушения и планы выпадали). Правила — ровно
 * `computeMetrics` для `plans`/`done`/`violations`:
 *  - окно, выпуск, без тестовых сессий мастера;
 *  - потолок вклада — `cappedPlanIds`: план среди `perVisitorPlans` самых
 *    новых своего посетителя И своего хеша IP (строка `plan` журнала);
 *  - исполнимый план — есть шаг `auto|confirm`; `done` — статус `done`,
 *    все исполнимые шаги `done`, ни один шаг не `manual`/`failed`;
 *  - нарушения — все строки `violation` планов окна (сверх потолка тоже).
 * Сверка с `computeMetrics` на одной фикстуре — приёмка e6b.
 */
export async function canaryAggregates(
  db: RawDb,
  p: { since: Date; release: string },
): Promise<{ plans: number; done: number; violations: number }> {
  const rows = await db.$queryRawUnsafe<
    Array<{ plans: bigint; done: bigint; violations: bigint }>
  >(
    `WITH w AS (
       SELECT pl."id", pl."visitorId", pl."createdAt", pl."status",
              CASE WHEN jsonb_typeof(pl."steps") = 'array' THEN pl."steps" ELSE '[]'::jsonb END AS steps,
              (SELECT l."target"->>'ip' FROM ${LOG} l
                WHERE l."planId" = pl."id" AND l."action" = 'plan'
                  AND jsonb_typeof(l."target") = 'object'
                  AND jsonb_typeof(l."target"->'ip') = 'string'
                  AND length(l."target"->>'ip') BETWEEN 1 AND 128
                ORDER BY l."createdAt" DESC, l."id" DESC LIMIT 1) AS ip
         FROM ${PLANS} pl
        WHERE pl."createdAt" >= $1 AND pl."voiceTestId" IS NULL AND pl."release" = $2
     ), r AS (
       SELECT w.*,
              CASE WHEN w."visitorId" = '' THEN 1 ELSE ROW_NUMBER() OVER (
                PARTITION BY w."visitorId" ORDER BY w."createdAt" DESC, w."id" ASC) END AS rv,
              CASE WHEN w.ip IS NULL THEN 1 ELSE ROW_NUMBER() OVER (
                PARTITION BY w.ip ORDER BY w."createdAt" DESC, w."id" ASC) END AS ri
         FROM w
     ), c AS (
       SELECT r."status",
              EXISTS (SELECT 1 FROM jsonb_array_elements(r.steps) s
                       WHERE s->'risk' IN ('"auto"'::jsonb, '"confirm"'::jsonb)) AS exec,
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.steps) s
                           WHERE (s->'risk' IN ('"auto"'::jsonb, '"confirm"'::jsonb)
                                  AND (s->'state') IS DISTINCT FROM '"done"'::jsonb)
                              OR s->'state' IN ('"manual"'::jsonb, '"failed"'::jsonb)) AS clean
         FROM r WHERE r.rv <= $3 AND r.ri <= $3
     )
     SELECT (SELECT count(*) FROM c WHERE c.exec) AS plans,
            (SELECT count(*) FROM c WHERE c.exec AND c.clean AND c."status" = 'done') AS done,
            (SELECT count(*) FROM ${LOG} l JOIN w ON l."planId" = w."id"
              WHERE l."action" = 'violation') AS violations`,
    p.since,
    p.release,
    MONITOR_THRESHOLDS.perVisitorPlans,
  );
  const r = rows[0];
  return {
    plans: Number(r?.plans ?? 0),
    done: Number(r?.done ?? 0),
    violations: Number(r?.violations ?? 0),
  };
}

/** Счётчики распознавания маршрута голоса (заход 9): `vc-stt`, час UTC. */
export const STT_COUNTER_SCOPE = 'vc-stt';

/** Ключ часа счётчика: `YYYY-MM-DDTHH` (UTC) — сравним строками по порядку. */
export function sttHour(d: Date): string {
  return d.toISOString().slice(0, 13);
}

/**
 * «Не расслышал» по языкам за 24 ч (§5-бис.14): сумма часовых счётчиков
 * `vc-stt` сайта (`<siteId>:<lang>:heard|not_heard`). Ретенция — общая
 * чистка `assist_daily_counters` (старше 2 суток).
 */
export async function readSttCounters(
  db: RawDb,
  siteId: string,
  now: Date,
): Promise<Record<string, { heard: number; notHeard: number }>> {
  const rows = await db.$queryRawUnsafe<Array<{ key: string; n: bigint }>>(
    `SELECT "key", SUM("value") AS n FROM ${COUNTERS}
      WHERE "scope" = $1 AND "key" LIKE $2 AND "day" > $3
      GROUP BY "key"`,
    STT_COUNTER_SCOPE,
    `${siteId.replace(/[\\%_]/g, '\\$&')}:%`,
    sttHour(new Date(now.getTime() - MONITOR_THRESHOLDS.windowMs)),
  );
  const out: Record<string, { heard: number; notHeard: number }> = {};
  for (const r of rows) {
    const m = /:([a-z]{2,3}):(heard|not_heard)$/.exec(r.key);
    if (!m) continue;
    const c = (out[m[1]] ??= { heard: 0, notHeard: 0 });
    if (m[2] === 'heard') c.heard += Number(r.n);
    else c.notHeard += Number(r.n);
  }
  return out;
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
