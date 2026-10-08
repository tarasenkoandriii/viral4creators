/**
 * Срок хранения суточных агрегатов аналитики по тарифу (заход 9, хвост
 * Э3-бис (4); ТЗ §5-тер.10, §5-тер.15, таблица §5-тер.17: «Хранение
 * агрегатов … 13 мес | 25 мес» — Pro 25 месяцев, остальные 13).
 *
 * Срок — по тарифу кабинета НА МОМЕНТ уборки (суточный крон): Pro хранит
 * счётчики событий, суточные итоги и свёртку поведения 25 месяцев; после
 * истечения Pro или перехода на Business — ещё 90 дней льготы (аудит P2-3),
 * затем лишнее уходит при уборке. Самый короткий
 * срок ТЗ (3 мес у младшего тарифа) не вводится: удаление необратимо, а
 * диск на сайт — доли цента (§5-тер.10 «Оценка объёма»), апгрейд же должен
 * показать историю (решение захода 9).
 *
 * События целей (`orderId`), выводы и калибровки — 13 мес у всех (§5-тер.15:
 * это не агрегаты).
 */
import type { PrismaService } from '../../prisma/prisma.service';
import type { AssistPlanId } from '../assist-billing/plans';
import { readState } from '../assist-billing/public/entitlements';

const DAY = 24 * 60 * 60 * 1000;

/** Месяцев хранения агрегатов по тарифу (§5-тер.17). */
export const AGGREGATES_RETENTION_MONTHS: Record<AssistPlanId, number> = {
  trial: 13,
  start: 13,
  business: 13,
  pro: 25,
};

/** Месяцы → миллисекунды (средний месяц, с округлением вверх до суток). */
export function monthsMs(months: number): number {
  return Math.ceil(months * 30.4375) * DAY;
}

/** Базовый срок (13 мес) — как `ANALYTICS_DEFAULTS.dailyTotalsRetentionMs`. */
export const BASE_AGGREGATES_RETENTION_MS = monthsMs(13);
/** Самый длинный срок (Pro). */
export const MAX_AGGREGATES_RETENTION_MS = monthsMs(
  Math.max(...Object.values(AGGREGATES_RETENTION_MONTHS)),
);

export function aggregatesRetentionMs(planId: AssistPlanId | null): number {
  return monthsMs(AGGREGATES_RETENTION_MONTHS[planId ?? 'start'] ?? 13);
}

/**
 * Льгота после длинного тарифа (аудит P2-3): истечение, неоплата или
 * переход на младший тариф не стирают сразу историю 13–25 мес — длинный
 * срок держится, пока длинный тариф был в последние 90 дней.
 */
export const LONG_RETENTION_GRACE_MS = 90 * DAY;
/** Оплаченный период подписки (платёж → доступ ещё на столько). */
const PAID_PERIOD_MS = 30 * DAY;

const LONG_PLANS = (
  Object.keys(AGGREGATES_RETENTION_MONTHS) as AssistPlanId[]
).filter((p) => AGGREGATES_RETENTION_MONTHS[p] > 13);

/**
 * Срок агрегатов кабинета: по тарифу сейчас, а если длинный тариф был в
 * последние 90 дней — длинный. Источники истории (надёжные, пишет только
 * биллинг): строка подписки (`planId` + `paidThrough` — истёкшая/неоплаченная
 * Pro остаётся в строке до смены тарифа) и успешные платежи подписки за
 * Pro (`assist_payments`: после перехода на Business строка подписки уже
 * Business, а платёж за Pro в истории). Ручной тариф пилота без платежей,
 * сменённый оператором, льготы не получает — только по строке подписки.
 */
export async function accountRetentionMs(
  prisma: PrismaService,
  accountId: string,
  now: Date,
): Promise<number> {
  const st = await readState(prisma, accountId, now);
  const current = aggregatesRetentionMs(st.planId);
  if (current >= MAX_AGGREGATES_RETENTION_MS || !LONG_PLANS.length) {
    return current;
  }
  const since = new Date(now.getTime() - LONG_RETENTION_GRACE_MS);
  const [r] = await prisma.$queryRawUnsafe<Array<{ long: boolean }>>(
    `SELECT EXISTS (
              SELECT 1 FROM "sites"."assist_subscriptions" s
               WHERE s."accountId" = $1 AND s."planId" = ANY($2::text[])
                 AND s."paidThrough" >= $3)
         OR EXISTS (
              SELECT 1 FROM "sites"."assist_payments" p
               WHERE p."accountId" = $1 AND p."planId" = ANY($2::text[])
                 AND p."status" = 'succeeded' AND p."kind" IN ('subscription', 'renewal')
                 AND p."paidAt" >= $4) AS long`,
    accountId,
    LONG_PLANS,
    since,
    new Date(since.getTime() - PAID_PERIOD_MS),
  );
  return r?.long ? MAX_AGGREGATES_RETENTION_MS : current;
}

/**
 * Границы уборки агрегатов: `base` — для всех, `long` — для сайтов с
 * длинным сроком (`longSiteIds`). Строка удаляется, если старше `long`,
 * или старше `base` и сайт не в `longSiteIds`.
 */
export interface AggregatesCutoff {
  base: Date;
  long: Date;
  longSiteIds: string[];
}

/**
 * Сайты (из `candidates` — у них есть строки старше базового срока), чей
 * кабинет сейчас на тарифе с длинным сроком. Тариф читается раз на кабинет.
 */
export async function aggregatesCutoff(
  prisma: PrismaService,
  candidates: Array<{ siteId: string; accountId: string }>,
  now: Date,
): Promise<AggregatesCutoff> {
  const long: string[] = [];
  const byAccount = new Map<string, number>();
  for (const c of candidates) {
    let ms = byAccount.get(c.accountId);
    if (ms === undefined) {
      ms = await accountRetentionMs(prisma, c.accountId, now);
      byAccount.set(c.accountId, ms);
    }
    if (ms > BASE_AGGREGATES_RETENTION_MS) long.push(c.siteId);
  }
  return {
    base: new Date(now.getTime() - BASE_AGGREGATES_RETENTION_MS),
    long: new Date(now.getTime() - MAX_AGGREGATES_RETENTION_MS),
    longSiteIds: long,
  };
}

/**
 * Сайты (с кабинетом) из `scope`, у которых в одной из таблиц есть строки
 * старше базового срока, — только им нужен тариф (обычно единицы).
 */
export async function oldAggregateSites(
  prisma: PrismaService,
  tables: string[],
  cutoffDay: string,
  scopeIds: string[] | null,
): Promise<Array<{ siteId: string; accountId: string }>> {
  const exists = tables
    .map(
      (t) =>
        `EXISTS (SELECT 1 FROM "sites"."${t}" x WHERE x."siteId" = a."siteId" AND x."day" < $1)`,
    )
    .join(' OR ');
  return prisma.$queryRawUnsafe<Array<{ siteId: string; accountId: string }>>(
    `SELECT a."siteId", a."accountId" FROM "sites"."assist_sites" a
      WHERE ($2::text[] IS NULL OR a."siteId" = ANY($2::text[])) AND (${exists})`,
    cutoffDay,
    scopeIds,
  );
}

/** Границы уборки строкой дня YYYY-MM-DD (колонки `day` агрегатов). */
export function cutoffDays(c: AggregatesCutoff): {
  base: string;
  long: string;
} {
  return {
    base: c.base.toISOString().slice(0, 10),
    long: c.long.toISOString().slice(0, 10),
  };
}
