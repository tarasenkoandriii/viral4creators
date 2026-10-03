/**
 * Свёртка поведения страниц (Э3-бис; ТЗ §5-тер.10, §5-тер.15, Р-46) —
 * системный код суточного крона `assist-analytics-rollup`. Основная роль.
 *
 * Сырые итоги просмотров (`assist_site_page_views`, 7 дней) → суточная
 * свёртка `assist_site_daily_pages` по суткам сайта: топ-200 путей по
 * просмотрам + «*» (прочие), медианы активного времени и прокрутки,
 * перцентиль p75 полевых CWV (`percentile_cont` в SQL), уходы с форм по
 * полям (топ-5). «Целиком сырое или целиком свёрнутое»: строка дня
 * пересчитывается ЦЕЛИКОМ в одной транзакции (повтор не удваивает,
 * §5-тер.16 п.17). Экран и выводы читают только свёртку.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import type { CronScope } from '../../../common/cron-scope';
import { ANALYTICS_DEFAULTS } from '../../../config/assist-defaults';
import { addDays, dayInTz, dayRangeUtc, siteTz } from '../site-time';

const DAY = 24 * 60 * 60 * 1000;
export const RAW_PAGE_VIEWS_RETENTION_MS = 7 * DAY;
/** Хеш визита у событий целей (база мощности — 28 дней + запас). */
export const VISIT_HASH_RETENTION_MS = 35 * DAY;
export const TOP_PATHS = 200;

@Injectable()
export class BehaviorRollup {
  private readonly logger = new Logger(BehaviorRollup.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Сутки сайта целиком из сырых строк (идемпотентно). */
  async rollupDay(siteId: string, day: string): Promise<number> {
    const site = await this.prisma.assistSite.findUnique({
      where: { siteId },
      select: { accountId: true, timezone: true },
    });
    if (!site) return 0;
    const { start, end } = dayRangeUtc(day, siteTz(site.timezone));
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM "sites"."assist_site_daily_pages" WHERE "siteId" = $1 AND "day" = $2`,
        siteId,
        day,
      );
      return tx.$executeRawUnsafe(
        `WITH v AS (
           SELECT * FROM "sites"."assist_site_page_views"
            WHERE "siteId" = $1 AND "startedAt" >= $2 AND "startedAt" < $3
         ),
         top AS (
           SELECT "path" FROM v GROUP BY "path" ORDER BY count(*) DESC, "path" LIMIT ${TOP_PATHS}
         ),
         lab AS (
           SELECT CASE WHEN v."path" IN (SELECT "path" FROM top) THEN v."path" ELSE '*' END AS p, v.*
             FROM v
         ),
         fields AS (
           SELECT p, jsonb_object_agg(f, n) AS j FROM (
             SELECT p, f, n, row_number() OVER (PARTITION BY p ORDER BY n DESC, f) AS rn FROM (
               SELECT p, "formAbandonField" AS f, count(*)::int AS n FROM lab
                WHERE "formStarted" AND NOT "formSubmitted" AND "formAbandonField" IS NOT NULL
                GROUP BY p, "formAbandonField") x) y
            WHERE rn <= 5 GROUP BY p
         )
         INSERT INTO "sites"."assist_site_daily_pages"
           ("accountId", "siteId", "day", "path", "views", "activeMsMedian", "scrollMedian",
            "deepScroll", "backNav", "rage", "jsErrors", "formStarts", "formAbandons",
            "abandonFields", "lcpP75", "inpP75", "clsP75", "chatOpens", "computedAt")
         SELECT $4, $1, $5, lab.p, count(*)::int,
                COALESCE(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY "activeMs")), 0)::int,
                COALESCE(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY "scrollMax")), 0)::int,
                count(*) FILTER (WHERE "scrollMax" >= 75)::int,
                count(*) FILTER (WHERE "backNav")::int,
                COALESCE(sum("rageClicks"), 0)::int,
                COALESCE(sum("jsErrors"), 0)::int,
                count(*) FILTER (WHERE "formStarted")::int,
                count(*) FILTER (WHERE "formStarted" AND NOT "formSubmitted")::int,
                COALESCE((SELECT j FROM fields WHERE fields.p = lab.p), '{}'::jsonb),
                round(percentile_cont(0.75) WITHIN GROUP (ORDER BY "lcpMs"))::int,
                round(percentile_cont(0.75) WITHIN GROUP (ORDER BY "inpMs"))::int,
                (percentile_cont(0.75) WITHIN GROUP (ORDER BY "cls"))::float8,
                count(*) FILTER (WHERE "chatOpened")::int,
                now()
           FROM lab GROUP BY lab.p`,
        siteId,
        start,
        end,
        site.accountId,
        day,
      );
    });
  }

  /** Суточный проход: вчера и позавчера сайтов с сырыми строками; уборка. */
  async daily(
    now: Date,
    scope?: CronScope,
  ): Promise<{ sites: number; rows: number; purged: number }> {
    const sites = await this.prisma.$queryRawUnsafe<
      Array<{ siteId: string; timezone: string }>
    >(
      `SELECT DISTINCT v."siteId", a."timezone"
         FROM "sites"."assist_site_page_views" v
         JOIN "sites"."assist_sites" a ON a."siteId" = v."siteId"
        WHERE v."day" >= $1 AND ($2::text[] IS NULL OR v."siteId" = ANY($2::text[]))`,
      new Date(now.getTime() - 3 * DAY).toISOString().slice(0, 10),
      scope ? scope.siteIds : null,
    );
    let rows = 0;
    for (const s of sites) {
      const today = dayInTz(now, siteTz(s.timezone));
      for (const back of [1, 2]) {
        try {
          rows += await this.rollupDay(s.siteId, addDays(today, -back));
        } catch (e) {
          this.logger.warn(
            `свёртка поведения ${s.siteId} не удалась (${(e as Error | null)?.name ?? 'Error'})`,
          );
        }
      }
    }
    const ids = scope ? scope.siteIds : null;
    const purged = await this.prisma.$executeRawUnsafe(
      `DELETE FROM "sites"."assist_site_page_views"
        WHERE "startedAt" < $1 AND ($2::text[] IS NULL OR "siteId" = ANY($2::text[]))`,
      new Date(now.getTime() - RAW_PAGE_VIEWS_RETENTION_MS),
      ids,
    );
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM "sites"."assist_site_daily_pages"
        WHERE "day" < $1 AND ($2::text[] IS NULL OR "siteId" = ANY($2::text[]))`,
      new Date(now.getTime() - ANALYTICS_DEFAULTS.dailyTotalsRetentionMs)
        .toISOString()
        .slice(0, 10),
      ids,
    );
    // Хеш визита у событий целей нужен базе мощности экспериментов (28 дней):
    // старше 35 дней — обнуляется (связь с визитом не хранится дольше нужного).
    await this.prisma.$executeRawUnsafe(
      `UPDATE "sites"."assist_site_goal_events" SET "visitHash" = NULL
        WHERE "visitHash" IS NOT NULL AND "occurredAt" < $1
          AND ($2::text[] IS NULL OR "siteId" = ANY($2::text[]))`,
      new Date(now.getTime() - VISIT_HASH_RETENTION_MS),
      ids,
    );
    // Выводы недели и калибровки score — 13 мес (§5-тер.15; аудит Э3-бис:
    // уборки не было). Последняя калибровка сайта остаётся — по ней
    // считается вероятность Pro, пока не подобрана новая.
    const cutoff = new Date(
      now.getTime() - ANALYTICS_DEFAULTS.dailyTotalsRetentionMs,
    );
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM "sites"."assist_site_insights"
        WHERE "weekStart" < $1 AND ($2::text[] IS NULL OR "siteId" = ANY($2::text[]))`,
      cutoff.toISOString().slice(0, 10),
      ids,
    );
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM "sites"."assist_site_lead_calibrations" k
        WHERE k."createdAt" < $1 AND ($2::text[] IS NULL OR k."siteId" = ANY($2::text[]))
          AND k."version" < (SELECT max(x."version") FROM "sites"."assist_site_lead_calibrations" x
                              WHERE x."siteId" = k."siteId")`,
      cutoff,
      ids,
    );
    return { sites: sites.length, rows, purged };
  }
}
