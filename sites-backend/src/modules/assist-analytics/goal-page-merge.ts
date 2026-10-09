/**
 * Слияние verified-события цели с ближайшим page-событием (§5-тер.1
 * «Дедуп и доверие», §5-тер.16 п.5). Отдельный модуль, а не функция
 * `goal-webhook.service`: её зовут и вебхук (`GoalWebhookService`), и свёртка
 * (`AnalyticsRollup.mergePendingPageEvents`), а вебхук инжектирует свёртку.
 * Импорт свёртки из файла вебхука давал цикл модулей: на момент декорирования
 * `GoalWebhookService` класс `AnalyticsRollup` был ещё `undefined`, Nest
 * молча подставлял `undefined` в `@Optional()`-параметр, и пересчёт дня
 * заказа при возврате не выполнялся (заход 12, аудит P2-1). Этот модуль
 * не импортирует ни один сервис.
 */
import { ANALYTICS_DEFAULTS } from '../../config/assist-defaults';
import type { PrismaService } from '../../prisma/prisma.service';

type Db = Pick<PrismaService, '$executeRawUnsafe'>;

/**
 * Слить page-событие той же цели без orderId (±30 мин) в verified-строку.
 * Один UPDATE … FROM (DELETE … RETURNING): page-строка исчезает, её
 * атрибуция/диалог/путь переходят в verified. true — слили.
 */
export async function mergeNearestPage(
  db: Db,
  verifiedId: string,
): Promise<boolean> {
  const win = Math.round(ANALYTICS_DEFAULTS.mergeWindowMs / 1000);
  const n = await db.$executeRawUnsafe(
    `WITH v AS (
       SELECT "id", "siteId", "goalId", "occurredAt"
         FROM "sites"."assist_site_goal_events"
        WHERE "id" = $1 AND "trust" = 'verified'
     ),
     p AS (
       SELECT e."id" FROM "sites"."assist_site_goal_events" e, v
        WHERE e."siteId" = v."siteId" AND e."goalId" = v."goalId"
          AND e."trust" = 'page' AND e."orderId" IS NULL
          AND e."occurredAt" BETWEEN v."occurredAt" - ($2::int * interval '1 second')
                                 AND v."occurredAt" + ($2::int * interval '1 second')
        ORDER BY abs(extract(epoch FROM e."occurredAt" - v."occurredAt")), e."id"
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     ),
     d AS (
       DELETE FROM "sites"."assist_site_goal_events" e USING p
        WHERE e."id" = p."id"
        RETURNING e."attribution", e."conversationId", e."assist", e."path"
     )
     UPDATE "sites"."assist_site_goal_events" t
        SET "attribution" = CASE WHEN d."attribution" IN ('direct', 'assisted', 'unassisted')
                                 THEN d."attribution" ELSE t."attribution" END,
            "conversationId" = COALESCE(t."conversationId", d."conversationId"),
            "assist" = COALESCE(t."assist", d."assist"),
            "path" = COALESCE(t."path", d."path")
       FROM d
      WHERE t."id" = $1`,
    verifiedId,
    win,
  );
  return n > 0;
}
