/**
 * Ретенция виджета — W3 (ТЗ §6.3, §4.15 `assist-retention`): диалоги
 * (каскадом сообщения) старше assist_sites.retentionDays по lastMessageAt;
 * лиды старше leadRetentionDays; просроченные resumeKey, токены
 * предпросмотра, кэш, окна лимитов; строки денег дня старше 40 дней;
 * версии вида/персоны сверх последних 20 (кроме опубликованной); события
 * лендинга старше 90 дней; черновики `wd_` после expiresAt; (Э5) озвучка
 * ответов после expiresAt (7 дней); (Э6-бис, аудит) сырые значения
 * голосовых планов (`assist_site_ui_plans.liveValues`) у неживых и
 * истёкших планов — сами планы и журнал шагов уходят каскадом с диалогом.
 * Пачками с бюджетом времени (функция Vercel). Зовётся из
 * AssistRetentionController (assist-sandbox/sandbox-retention.controller.ts —
 * правку вызова делает W3).
 *
 * Пачка — DELETE по id из подзапроса с LIMIT (у Postgres нет DELETE …
 * LIMIT): короткие транзакции, не держат таблицу. Бюджет времени исчерпан —
 * остаток удалит следующий запуск (крон ежедневный, сроки — дни).
 * Системный код (папка system/) — основная роль: у assist_public нет DELETE
 * на лиды, версии и события.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  LANDING_DEFAULTS,
  WIDGET_DEFAULTS,
} from '../../../config/assist-defaults';
import { PrismaService } from '../../../prisma/prisma.service';

export interface ChatRetentionResult {
  conversationsDeleted: number;
  leadsDeleted: number;
  resumesDeleted: number;
  previewTokensDeleted: number;
  cacheDeleted: number;
  rateBucketsDeleted: number;
  budgetDaysDeleted: number;
  configVersionsDeleted: number;
  landingEventsDeleted: number;
  widgetDraftsDeleted: number;
  /** Э5: просроченная озвучка ответов (7 дней, §4.10). */
  ttsCacheDeleted: number;
  /** Э6-бис: обнулено сырых значений планов (завершены/истекли без визита). */
  uiPlanValuesCleared: number;
}

/** Строки денег дня храним 40 дней (сверка с отчётом расходов за месяц). */
export const BUDGET_DAYS_KEEP = 40;
export const RETENTION_BATCH = 1_000;
export const RETENTION_TIME_BUDGET_MS = 45_000;

const S = '"sites"';

@Injectable()
export class ChatRetention {
  private readonly logger = new Logger(ChatRetention.name);
  batch = RETENTION_BATCH;
  timeBudgetMs = RETENTION_TIME_BUDGET_MS;

  constructor(private readonly prisma: PrismaService) {}

  async run(now: Date = new Date()): Promise<ChatRetentionResult> {
    const deadline = Date.now() + this.timeBudgetMs;
    const day = 86_400_000;
    const r: ChatRetentionResult = {
      conversationsDeleted: 0,
      leadsDeleted: 0,
      resumesDeleted: 0,
      previewTokensDeleted: 0,
      cacheDeleted: 0,
      rateBucketsDeleted: 0,
      budgetDaysDeleted: 0,
      configVersionsDeleted: 0,
      landingEventsDeleted: 0,
      widgetDraftsDeleted: 0,
      ttsCacheDeleted: 0,
      uiPlanValuesCleared: 0,
    };
    // Диалоги — по сроку СВОЕГО сайта (30–365, §6.3); сообщения — каскадом,
    // лиды — SET NULL (у лида свой срок).
    r.conversationsDeleted = await this.drain(
      deadline,
      `DELETE FROM ${S}."assist_site_conversations" WHERE "id" IN (
         SELECT c."id" FROM ${S}."assist_site_conversations" c
           JOIN ${S}."assist_sites" s ON s."siteId" = c."siteId"
          WHERE c."lastMessageAt" < $1::timestamptz - make_interval(days => s."retentionDays")
          LIMIT $2)`,
      now,
    );
    r.leadsDeleted = await this.drain(
      deadline,
      `DELETE FROM ${S}."assist_site_leads" WHERE "id" IN (
         SELECT l."id" FROM ${S}."assist_site_leads" l
           JOIN ${S}."assist_sites" s ON s."siteId" = l."siteId"
          WHERE l."createdAt" < $1::timestamptz - make_interval(days => s."leadRetentionDays")
          LIMIT $2)`,
      now,
    );
    r.resumesDeleted = await this.drain(
      deadline,
      `DELETE FROM ${S}."assist_site_visitor_resumes" WHERE "keyHash" IN (
         SELECT "keyHash" FROM ${S}."assist_site_visitor_resumes" WHERE "expiresAt" < $1 LIMIT $2)`,
      now,
    );
    r.previewTokensDeleted = await this.drain(
      deadline,
      `DELETE FROM ${S}."assist_site_preview_tokens" WHERE "id" IN (
         SELECT "id" FROM ${S}."assist_site_preview_tokens"
          WHERE "expiresAt" < $1 AND ("sessionExpiresAt" IS NULL OR "sessionExpiresAt" < $1)
          LIMIT $2)`,
      now,
    );
    r.cacheDeleted = await this.drain(
      deadline,
      `DELETE FROM ${S}."assist_site_semantic_cache" WHERE "id" IN (
         SELECT "id" FROM ${S}."assist_site_semantic_cache" WHERE "expiresAt" < $1 LIMIT $2)`,
      now,
    );
    r.rateBucketsDeleted = await this.drain(
      deadline,
      `DELETE FROM ${S}."assist_rate_buckets" WHERE ("scope", "key", "bucket") IN (
         SELECT "scope", "key", "bucket" FROM ${S}."assist_rate_buckets" WHERE "expiresAt" < $1 LIMIT $2)`,
      now,
    );
    const budgetCutoff = new Date(now.getTime() - BUDGET_DAYS_KEEP * day)
      .toISOString()
      .slice(0, 10);
    r.budgetDaysDeleted = await this.drain(
      deadline,
      `DELETE FROM ${S}."assist_budget_days" WHERE ("scope", "key", "day") IN (
         SELECT "scope", "key", "day" FROM ${S}."assist_budget_days" WHERE "day" < $1 LIMIT $2)`,
      budgetCutoff,
    );
    // Версии вида/персоны: последние configHistoryKeep каждого вида +
    // опубликованная (она может быть старше — откат к старой версии
    // создаёт НОВУЮ, но номер опубликованной не трогаем никогда).
    r.configVersionsDeleted = await this.drain(
      deadline,
      `DELETE FROM ${S}."assist_site_config_versions" WHERE "id" IN (
         SELECT v."id" FROM (
           SELECT cv."id", cv."siteId", cv."kind", cv."version",
                  row_number() OVER (PARTITION BY cv."siteId", cv."kind" ORDER BY cv."version" DESC) AS rn
             FROM ${S}."assist_site_config_versions" cv
         ) v
         JOIN ${S}."assist_sites" s ON s."siteId" = v."siteId"
        WHERE v."rn" > $1::int
          AND NOT (v."kind" = 'widget' AND v."version" = s."widgetVersion")
          AND NOT (v."kind" = 'persona' AND v."version" = s."configVersion")
        LIMIT $2)`,
      WIDGET_DEFAULTS.configHistoryKeep,
    );
    r.landingEventsDeleted = await this.drain(
      deadline,
      `DELETE FROM ${S}."assist_landing_events" WHERE "id" IN (
         SELECT "id" FROM ${S}."assist_landing_events" WHERE "createdAt" < $1 LIMIT $2)`,
      new Date(now.getTime() - LANDING_DEFAULTS.eventsRetentionDays * day),
    );
    r.widgetDraftsDeleted = await this.drain(
      deadline,
      `DELETE FROM ${S}."assist_widget_drafts" WHERE "id" IN (
         SELECT "id" FROM ${S}."assist_widget_drafts" WHERE "expiresAt" < $1 LIMIT $2)`,
      now,
    );
    r.ttsCacheDeleted = await this.drain(
      deadline,
      `DELETE FROM ${S}."assist_site_tts_cache" WHERE "id" IN (
         SELECT "id" FROM ${S}."assist_site_tts_cache" WHERE "expiresAt" < $1 LIMIT $2)`,
      now,
    );
    // Э6-бис: значения полей и текст команды держатся, только пока план
    // живой (plan-store.ts); посетитель ушёл, не дождавшись конца, — здесь.
    r.uiPlanValuesCleared = await this.drain(
      deadline,
      `UPDATE ${S}."assist_site_ui_plans" SET "liveValues" = NULL WHERE "id" IN (
         SELECT "id" FROM ${S}."assist_site_ui_plans"
          WHERE "liveValues" IS NOT NULL
            AND ("expiresAt" <= $1 OR "status" NOT IN ('proposed', 'confirmed', 'running', 'paused'))
          LIMIT $2)`,
      now,
    );
    this.logger.log(`ретенция виджета: ${JSON.stringify(r)}`);
    return r;
  }

  /** Пачками до нуля или до дедлайна. `$1` — параметр условия, `$2` — размер пачки. */
  private async drain(
    deadline: number,
    sql: string,
    param: unknown,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      if (Date.now() > deadline) break;
      const n = await this.prisma.$executeRawUnsafe(sql, param, this.batch);
      total += n;
      if (n < this.batch) break;
    }
    return total;
  }
}
