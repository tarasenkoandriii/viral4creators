/**
 * Приёмка Э0 на НАСТОЯЩЕМ Postgres: изоляция «Админки» ролью БД и
 * изоляция кабинетов (ТЗ помощника §4.3-бис слой 3 и п.4 теста-инварианта;
 * §4.4; план Э0, «Приёмка»).
 *
 * Где идёт: в CI (джоба sites-backend: Postgres `pgvector/pgvector:pg16`,
 * миграции накатаны `prisma migrate deploy` до jest). Строка — та же
 * `SITES_DIRECT_URL`, что у миграций. В песочнице без базы набор
 * ПРОПУСКАЕТСЯ с причиной в названии; в CI (`CI=true`) отсутствие строки —
 * провал, а не пропуск: иначе приёмка тихо перестала бы выполняться.
 *
 * Подключение — под владельцем схемы (суперпользователь в CI), а
 * `SET LOCAL ROLE assist_public` внутри транзакции переключает проверку
 * прав на публичную роль; ROLLBACK в конце не оставляет следов.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { tenantExtension } from './tenant';
import { SITES_DB_SCHEMA } from './prisma.service';
import { ASSIST_PUBLIC_OMIT } from './assist-public-db.service';

const RAW_URL = process.env.SITES_DIRECT_URL;

/** Э-С Ш2: хранилище учётных данных — роли виджета прав нет вовсе. */
const CREDENTIAL_TABLES = [
  'site_test_accounts',
  'site_credentials',
  'site_credential_leases',
  'user_site_sessions',
  'user_site_secrets',
  'site_credential_audit',
];
const IN_CI = process.env.CI === 'true';

/** `?schema=sites` нужен CLI Prisma; драйверу pg он ни к чему. */
function pgUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}

/** Таблицы «Админки» — из схемы, а не списком руками (§4.3-бис, п.4). */
function adminTables(): string[] {
  const schema = readFileSync(
    join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
    'utf8',
  );
  return [...schema.matchAll(/@@map\("(assist_admin_[^"]+)"\)/g)].map(
    (m) => m[1],
  );
}

if (!RAW_URL) {
  describe('изоляция на реальном Postgres', () => {
    // В CI пропуск недопустим — это и есть приёмка.
    (IN_CI ? it : it.skip)(
      'ПРОПУЩЕНО: нет SITES_DIRECT_URL (песочница без базы) — проверка идёт в CI, джоба sites-backend',
      () => {
        throw new Error(
          'CI=true, но SITES_DIRECT_URL не задана — приёмка изоляции не выполнилась',
        );
      },
    );
  });
} else {
  const url = pgUrl(RAW_URL);
  const S = `"${SITES_DB_SCHEMA}"`;

  describe('роль assist_public (реальный Postgres)', () => {
    let client: Client;

    beforeAll(async () => {
      client = new Client({ connectionString: url });
      await client.connect();
    });

    afterAll(async () => {
      await client.end();
    });

    /** Запрос под ролью assist_public; транзакция всегда откатывается. */
    async function asPublic(sql: string): Promise<void> {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE assist_public');
        await client.query(sql);
      } finally {
        await client.query('ROLLBACK');
      }
    }

    it('таблицы «Админки» в схеме нашлись — иначе проверка ниже пуста', () => {
      expect(adminTables()).toContain('assist_admin_chunks');
    });

    it.each(adminTables())(
      'SELECT из %s под assist_public падает (нет прав)',
      async (table) => {
        await expect(
          asPublic(`SELECT 1 FROM ${S}."${table}" LIMIT 1`),
        ).rejects.toMatchObject({ code: '42501' });
      },
    );

    it('контроль: SELECT из assist_site_chunks под той же ролью работает', async () => {
      // Без этого «падает» выше могло бы значить «таблицы нет» или «роли
      // нет», а не «прав нет».
      await expect(
        asPublic(`SELECT 1 FROM ${S}."assist_site_chunks" LIMIT 1`),
      ).resolves.toBeUndefined();
    });

    it.each([
      'site_accounts',
      'site_account_members',
      'site_ownership_challenges',
      '_prisma_migrations',
      // Э1: обход, источники, версии, исключения, бюджет — не публичное.
      'site_pages',
      'site_crawl_runs',
      'site_crawl_queue',
      'site_cron_locks',
      'assist_site_sources',
      'assist_site_documents',
      'assist_site_knowledge_versions',
      'assist_site_exclusions',
      'assist_site_eval_cases',
      'assist_site_eval_runs',
      'assist_learning_spend',
      // Э2: кабинетное и чужое публичному маршруту.
      'assist_site_wizards',
      'assist_acquisitions',
      'assist_widget_drafts',
      'assist_landing_events',
      // Э3: кабинет, секреты, свёртки, бот — не публичное.
      'assist_site_learning_items',
      'assist_site_learning_clusters',
      'assist_site_forget_jobs',
      'assist_site_goal_events',
      'assist_site_integrations',
      'assist_site_daily_totals',
      'assist_site_exports',
      'assist_site_report_subscriptions',
      'assist_bot_messages',
      'assist_bot_users',
      // Э4: деньги, документы и админка платформы — не публичное.
      'assist_payments',
      'assist_legal_acceptances',
      'assist_platform_access_log',
      'assist_platform_eval_candidates',
      // Э-С Ш1: id запросов внутреннего API генератора — не публичное.
      'site_internal_requests',
      // Э-С Ш2: тестовые учётки, их секреты, аренды, личные записи B и
      // журнал доступа — роли виджета НИКАКИХ прав.
      ...CREDENTIAL_TABLES,
    ])('SELECT из %s под assist_public падает', async (table) => {
      await expect(
        asPublic(`SELECT 1 FROM ${S}."${table}" LIMIT 1`),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('Э-С Ш2: на хранилище учётных данных у assist_public нет ни одной привилегии', async () => {
      const res = await client.query<{ t: string; p: string }>(
        `SELECT table_name AS t, privilege_type AS p
           FROM information_schema.table_privileges
          WHERE grantee = 'assist_public' AND table_schema = $1
            AND table_name = ANY($2::text[])`,
        [SITES_DB_SCHEMA, CREDENTIAL_TABLES],
      );
      expect(res.rows).toEqual([]);
      const cols = await client.query(
        `SELECT 1 FROM information_schema.column_privileges
          WHERE grantee = 'assist_public' AND table_schema = $1
            AND table_name = ANY($2::text[])`,
        [SITES_DB_SCHEMA, CREDENTIAL_TABLES],
      );
      expect(cols.rows).toEqual([]);
      for (const t of CREDENTIAL_TABLES) {
        await expect(
          asPublic(`DELETE FROM ${S}."${t}" WHERE false`),
        ).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('site_hosts: статусные колонки читаются, служебные — нет', async () => {
      await expect(
        asPublic(
          `SELECT "id", "host", "status", "expiresAt", "revokedAt" FROM ${S}."site_hosts" LIMIT 1`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(`SELECT "method" FROM ${S}."site_hosts" LIMIT 1`),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('site_opt_out_domains (Э1, песочница L0): domain читается, остальное — нет', async () => {
      await expect(
        asPublic(`SELECT "domain" FROM ${S}."site_opt_out_domains" LIMIT 1`),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(`SELECT "source" FROM ${S}."site_opt_out_domains" LIMIT 1`),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('Э1: опубликованная версия и FAQ «Сайта» читаются (поиск виджета/песочницы)', async () => {
      await expect(
        asPublic(`SELECT "knowledgeVersion" FROM ${S}."assist_sites" LIMIT 1`),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(
          `SELECT "question", "answer", "variants", "lang", "status" FROM ${S}."assist_site_faq" LIMIT 1`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(
          `UPDATE ${S}."assist_sites" SET "knowledgeVersion" = 1 WHERE false`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('Э2: черновики и telegramId роли не видны', async () => {
      for (const sql of [
        `SELECT "widgetDraft" FROM ${S}."assist_sites" LIMIT 1`,
        `SELECT "personaDraft" FROM ${S}."assist_sites" LIMIT 1`,
        `SELECT "createdByTelegramId" FROM ${S}."assist_site_faq" LIMIT 1`,
        `SELECT "approvedByTelegramId" FROM ${S}."assist_site_faq" LIMIT 1`,
        `SELECT "createdByTelegramId" FROM ${S}."assist_sandboxes" LIMIT 1`,
        `SELECT "createdByTelegramId" FROM ${S}."assist_site_preview_tokens" LIMIT 1`,
        `SELECT "publishedByTelegramId" FROM ${S}."assist_site_config_versions" LIMIT 1`,
        `UPDATE ${S}."assist_sandboxes" SET "accountId" = 'x' WHERE false`,
        `UPDATE ${S}."assist_sandboxes" SET "transferredAt" = now() WHERE false`,
        `UPDATE ${S}."assist_site_preview_tokens" SET "siteId" = 'x' WHERE false`,
        `UPDATE ${S}."assist_site_leads" SET "deliveryState" = 'x' WHERE false`,
        `DELETE FROM ${S}."assist_site_messages" WHERE false`,
      ]) {
        await expect(asPublic(sql)).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('Э3: закрытые колонки и системные поля передачи/лида/сообщения роли не видны', async () => {
      for (const sql of [
        `SELECT "fieldsEnc" FROM ${S}."assist_site_leads" LIMIT 1`,
        `SELECT "identityEnc" FROM ${S}."assist_site_leads" LIMIT 1`,
        `UPDATE ${S}."assist_site_leads" SET "identityVerified" = true WHERE false`,
        `SELECT "authorMemberId" FROM ${S}."assist_site_messages" LIMIT 1`,
        `UPDATE ${S}."assist_site_messages" SET "translation" = '{}' WHERE false`,
        `UPDATE ${S}."assist_site_messages" SET "role" = 'operator' WHERE false`,
        `SELECT "assignedTelegramId" FROM ${S}."assist_site_handoffs" LIMIT 1`,
        `SELECT "summary" FROM ${S}."assist_site_handoffs" LIMIT 1`,
        `UPDATE ${S}."assist_site_handoffs" SET "assignedMemberId" = 'x' WHERE false`,
        `UPDATE ${S}."assist_site_handoffs" SET "takenAt" = now() WHERE false`,
        `SELECT "createdByTelegramId" FROM ${S}."assist_site_goals" LIMIT 1`,
        `UPDATE ${S}."assist_site_goal_events" SET "trust" = 'verified' WHERE false`,
        `UPDATE ${S}."assist_site_learning_items" SET "status" = 'resolved' WHERE false`,
        `SELECT "currency" FROM ${S}."assist_sites" LIMIT 1`,
        `SELECT "result" FROM ${S}."assist_site_preview_tokens" LIMIT 1`,
        // Сужение Э2: счётчики — только свои колонки.
        `UPDATE ${S}."assist_site_conversations" SET "visitorId" = 'x' WHERE false`,
        `UPDATE ${S}."assist_site_conversations" SET "siteId" = 'x' WHERE false`,
        `UPDATE ${S}."assist_budget_days" SET "key" = 'x' WHERE false`,
        // Э4: докупку и автодокупку пишет только основная роль.
        `UPDATE ${S}."assist_account_usage" SET "extraUnits" = 1000000 WHERE false`,
        `UPDATE ${S}."assist_account_usage" SET "autoSpentMicroUsd" = 0 WHERE false`,
        `SELECT "recTokenEnc" FROM ${S}."assist_subscriptions" LIMIT 1`,
        `SELECT "starsChargeId" FROM ${S}."assist_subscriptions" LIMIT 1`,
        `UPDATE ${S}."assist_subscriptions" SET "planId" = 'pro' WHERE false`,
        `SELECT "updatedBy" FROM ${S}."assist_platform_settings" LIMIT 1`,
        `UPDATE ${S}."assist_rate_buckets" SET "expiresAt" = now() WHERE false`,
        `UPDATE ${S}."assist_site_semantic_cache" SET "siteId" = 'x' WHERE false`,
        `UPDATE ${S}."assist_site_visitor_resumes" SET "visitorId" = 'x' WHERE false`,
        `UPDATE ${S}."assist_site_install_pings" SET "siteId" = 'x' WHERE false`,
      ]) {
        await expect(asPublic(sql)).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('Э3: виджет создаёт передачу, сигнал очереди, событие цели и счётчик; отвязывает лид', async () => {
      for (const sql of [
        `SELECT "handoffConfig", "handoffEtaMinutes", "timezone", "analytics" FROM ${S}."assist_sites" LIMIT 1`,
        `SELECT "id", "state", "timeoutAt", "takenAt" FROM ${S}."assist_site_handoffs" LIMIT 1`,
        `UPDATE ${S}."assist_site_handoffs" SET "state" = 'cancelled', "closedAt" = now(), "closedBy" = 'visitor' WHERE false`,
        `UPDATE ${S}."assist_site_conversations" SET "handoffState" = 'waiting' WHERE false`,
        `UPDATE ${S}."assist_site_messages" SET "trace" = '{}', "lang" = 'uk' WHERE false`,
        `UPDATE ${S}."assist_site_leads" SET "visitorId" = NULL WHERE "siteId" = 's' AND "visitorId" = 'v'`,
        `SELECT "detectors", "status" FROM ${S}."assist_site_goals" LIMIT 1`,
        // Ровно те колонки, что шлёт Prisma createMany (поля + @default).
        `INSERT INTO ${S}."assist_site_handoffs" ("id", "accountId", "siteId", "conversationId", "state", "reason", "escalation", "visitorLang", "pageUrl", "identityEnc", "requestedAt", "timeoutAt", "reminders", "attempts", "costMicroUsd", "createdAt", "updatedAt") SELECT 'h', 'a', 's', 'c', 'waiting', 'visitor', NULL, 'uk', NULL, NULL, now(), now(), 0, 0, 0, now(), now() WHERE false`,
        `INSERT INTO ${S}."assist_site_learning_items" ("id", "accountId", "siteId", "kind", "conversationId", "messageId", "visitorId", "suspicious", "signal", "questionMasked", "answerMasked", "lang", "questionEmbedding", "status", "createdAt", "updatedAt") SELECT 'i', 'a', 's', 'unknown', 'c', 'm', 'v', false, 'no_answer', 'q', NULL, 'uk', NULL, 'new', now(), now() WHERE false ON CONFLICT DO NOTHING`,
        `INSERT INTO ${S}."assist_site_goal_events" ("id", "accountId", "siteId", "goalId", "occurredAt", "source", "trust", "clientEventId", "status", "attribution") SELECT 'e', 'a', 's', 'g', now(), 'loader', 'page', 'd:k:url', 'completed', 'unassisted' WHERE false ON CONFLICT DO NOTHING`,
        `INSERT INTO ${S}."assist_site_forget_jobs" ("id", "siteId", "conversationIds") SELECT 'f', 's', ARRAY['c'] WHERE false`,
        `UPDATE ${S}."assist_site_preview_tokens" SET "result" = '{}' WHERE false`,
        `INSERT INTO ${S}."assist_site_event_counts" ("siteId", "day", "kind", "key", "hour", "count") SELECT 's', '2026-10-03', 'open', '', 1, 1 WHERE false ON CONFLICT ("siteId", "day", "kind", "key", "hour") DO UPDATE SET "count" = ${S}."assist_site_event_counts"."count" + EXCLUDED."count"`,
      ]) {
        await expect(asPublic(sql)).resolves.toBeUndefined();
      }
    });

    it('Э4: виджет читает тариф кабинета и занимает единицы периода (ровно тот SQL, что шлёт entitlements.ts)', async () => {
      for (const sql of [
        `SELECT s."planId", s."status", s."method", s."anchorAt", s."paidThrough", s."cancelAtPeriodEnd", s."autoTopUp", s."autoTopUpCapMicroUsd", COALESCE((SELECT min(x."createdAt") FROM ${S}."assist_sites" x WHERE x."accountId" = 'a'), (SELECT min(y."createdAt") FROM ${S}."site_sites" y WHERE y."accountId" = 'a')) AS "trialStart" FROM (SELECT 1) AS one LEFT JOIN ${S}."assist_subscriptions" s ON s."accountId" = 'a'`,
        `INSERT INTO ${S}."assist_account_usage" ("accountId", "periodKey", "updatedAt") SELECT 'a', 'p', now() WHERE false ON CONFLICT DO NOTHING`,
        `UPDATE ${S}."assist_account_usage" SET "units" = "units" + 1, "dialogs" = "dialogs" + 1, "updatedAt" = now() WHERE "accountId" = 'a' AND "periodKey" = 'p' AND "units" + 1 <= 50 + "extraUnits" + CASE WHEN false AND "autoSpentMicroUsd" + 1 <= 0 THEN 100 ELSE 0 END`,
        `UPDATE ${S}."assist_account_usage" SET "exhaustedAt" = COALESCE("exhaustedAt", now()), "updatedAt" = now() WHERE "accountId" = 'a' AND "periodKey" = 'p'`,
        `SELECT "key", "value" FROM ${S}."assist_platform_settings" WHERE "key" = 'widget'`,
      ]) {
        await expect(asPublic(sql)).resolves.toBeUndefined();
      }
    });

    it('Э5: голос — ровно тот SQL, что шлёт assist-site-voice/public (конфиг, отметка диалога, резерв голоса, кэш озвучки)', async () => {
      for (const sql of [
        `SELECT "voiceConfig", "voiceDailyCapMicroUsd" FROM ${S}."assist_sites" LIMIT 1`,
        `UPDATE ${S}."assist_site_conversations" SET "voice" = true WHERE "id" = 'c' AND NOT "voice" RETURNING "answers", "dialogCounted"`,
        `UPDATE ${S}."assist_site_conversations" SET "voice" = false WHERE "id" = 'c'`,
        `INSERT INTO ${S}."assist_budget_reservations" ("id", "siteId", "day", "estMicroUsd", "expiresAt", "voice") SELECT 'r', 's', '2026-10-05', 1, now(), true WHERE false`,
        `INSERT INTO ${S}."assist_budget_days" ("scope", "key", "day", "updatedAt") SELECT 'voice', 's', '2026-10-05', now() WHERE false ON CONFLICT DO NOTHING`,
        `SELECT "mime", "audio" FROM ${S}."assist_site_tts_cache" WHERE "siteId" = 's' AND "key" = 'k' AND "expiresAt" > now()`,
        `INSERT INTO ${S}."assist_site_tts_cache" ("id", "siteId", "key", "voice", "lang", "mime", "audio", "characters", "expiresAt") SELECT 'i', 's', 'k', 'Maya', 'uk', 'audio/mpeg', '\\x00'::bytea, 1, now() WHERE false ON CONFLICT DO NOTHING`,
      ]) {
        await expect(asPublic(sql)).resolves.toBeUndefined();
      }
      for (const sql of [
        // Голос посетителя не правит ничего, кроме своей отметки.
        `UPDATE ${S}."assist_sites" SET "voiceConfig" = NULL WHERE false`,
        `UPDATE ${S}."assist_sites" SET "voiceDailyCapMicroUsd" = 0 WHERE false`,
        `UPDATE ${S}."assist_site_tts_cache" SET "audio" = '\\x00'::bytea WHERE false`,
        `DELETE FROM ${S}."assist_site_tts_cache" WHERE false`,
        `SELECT "voice", "lang", "characters" FROM ${S}."assist_site_tts_cache" LIMIT 1`,
      ]) {
        await expect(asPublic(sql)).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('Э6: видео и подсветка — ровно тот SQL, что шлёт assist-site-media/public (список, ролик для ссылки, карта страницы, сигнал «карта устарела»)', async () => {
      for (const sql of [
        `SELECT "id", "title", "locale", "durationMs" FROM ${S}."assist_site_videos" WHERE "siteId" = 's' AND "enabled" = true AND "requiresLogin" = false ORDER BY "title" ASC, "id" ASC LIMIT 8`,
        `SELECT "id", "title", "url" FROM ${S}."assist_site_videos" WHERE "id" = 'v' AND "siteId" = 's' AND "enabled" = true AND "requiresLogin" = false LIMIT 1`,
        // Prisma добавляет первичный ключ в SELECT списка (findMany с jsonb).
        `SELECT "id", "source", "elements" FROM ${S}."site_ui_maps" WHERE "siteId" = 's' AND "host" = 'h' AND "path" = '/' OFFSET 0`,
        `UPDATE ${S}."site_ui_maps" SET "staleSignals" = "staleSignals" + 1, "lastStaleAt" = now() WHERE "siteId" = 's' AND "host" = 'h' AND "path" = '/' AND "elements" @> '[{"id":"u00000000"}]'::jsonb`,
      ]) {
        await expect(asPublic(sql)).resolves.toBeUndefined();
      }
      for (const sql of [
        // Хозяин, черновик и id генератора — не виджету; ролики пишет только
        // внутренний API, включает — только кабинет.
        `SELECT "ownerTelegramId" FROM ${S}."assist_site_videos" LIMIT 1`,
        `SELECT "draftId" FROM ${S}."assist_site_videos" LIMIT 1`,
        `SELECT "externalId" FROM ${S}."assist_site_videos" LIMIT 1`,
        `UPDATE ${S}."assist_site_videos" SET "enabled" = true WHERE false`,
        `UPDATE ${S}."assist_site_videos" SET "requiresLogin" = false WHERE false`,
        `INSERT INTO ${S}."assist_site_videos" ("id", "accountId", "siteId", "externalId", "draftId", "ownerTelegramId", "title", "locale", "url", "syncedAt", "updatedAt") SELECT 'v', 'a', 's', 'e', 'd', 1, 't', 'ru', 'u', now(), now() WHERE false`,
        `DELETE FROM ${S}."assist_site_videos" WHERE false`,
        // Карту пишут обход и внутренний API; виджет — только счётчик промахов.
        `UPDATE ${S}."site_ui_maps" SET "elements" = '[]'::jsonb WHERE false`,
        `UPDATE ${S}."site_ui_maps" SET "path" = '/' WHERE false`,
        `INSERT INTO ${S}."site_ui_maps" ("id", "accountId", "siteId", "hostId", "host", "path", "source", "elements", "elementsHash", "capturedAt", "updatedAt") SELECT 'm', 'a', 's', 'h', 'x', '/', 'crawl', '[]', 'x', now(), now() WHERE false`,
        `DELETE FROM ${S}."site_ui_maps" WHERE false`,
        `SELECT "hostId" FROM ${S}."site_ui_maps" LIMIT 1`,
      ]) {
        await expect(asPublic(sql)).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('Э3 (решение 8): ON CONFLICT под ролью — с целью только там, где у роли SELECT на колонки цели; иначе без цели', async () => {
      // С целью конфликта Postgres требует SELECT на её колонки (и на
      // RETURNING). Ровно те UPSERT, что шлёт публичный код Э3:
      // EventCounts (A, W /event) и лимиты окон W (передача 5/ч, цели и
      // события на IP) — assist_rate_buckets, как rate-limit.ts.
      for (const sql of [
        `INSERT INTO ${S}."assist_site_event_counts" ("siteId", "day", "kind", "key", "hour", "count") SELECT 's', '2026-10-03', 'open', '', 1, 1 WHERE false ON CONFLICT ("siteId", "day", "kind", "key", "hour") DO UPDATE SET "count" = ${S}."assist_site_event_counts"."count" + EXCLUDED."count"`,
        `INSERT INTO ${S}."assist_rate_buckets" ("scope", "key", "bucket", "count", "expiresAt") VALUES ('widget-handoff-visitor-h', 'k', '2026-10-03T10', 1, now()) ON CONFLICT ("scope", "key", "bucket") DO UPDATE SET "count" = ${S}."assist_rate_buckets"."count" + 1 WHERE ${S}."assist_rate_buckets"."count" < 5 RETURNING "count"`,
      ]) {
        await expect(asPublic(sql)).resolves.toBeUndefined();
      }
      // Очередь обучения (L), события целей (A), задания forget (L): у роли
      // только INSERT — цель конфликта упала бы 42501, поэтому код шлёт
      // `ON CONFLICT DO NOTHING` без цели (Prisma skipDuplicates — так же).
      for (const sql of [
        `INSERT INTO ${S}."assist_site_learning_items" ("id", "accountId", "siteId", "kind", "conversationId", "messageId", "visitorId", "suspicious", "signal", "questionMasked", "answerMasked", "lang", "questionEmbedding", "status", "createdAt", "updatedAt") SELECT 'i', 'a', 's', 'unknown', 'c', 'm', 'v', false, 'no_answer', 'q', NULL, 'uk', NULL, 'new', now(), now() WHERE false ON CONFLICT ("messageId", "kind") DO NOTHING`,
        `INSERT INTO ${S}."assist_site_goal_events" ("id", "accountId", "siteId", "goalId", "occurredAt", "source", "trust", "clientEventId", "status", "attribution") SELECT 'e', 'a', 's', 'g', now(), 'loader', 'page', 'd:k:url', 'completed', 'unassisted' WHERE false ON CONFLICT ("siteId", "clientEventId") DO NOTHING`,
        `INSERT INTO ${S}."assist_site_goal_events" ("id", "accountId", "siteId", "goalId", "occurredAt", "source", "trust", "orderId", "status", "attribution") SELECT 'e', 'a', 's', 'g', now(), 'loader', 'page', 'A-1', 'completed', 'unassisted' WHERE false ON CONFLICT ("siteId", "goalId", "orderId") DO NOTHING`,
      ]) {
        await expect(asPublic(sql)).rejects.toMatchObject({ code: '42501' });
      }
      // Публичный код этих таблиц действительно шлёт вариант без цели.
      const fs = await import('fs');
      const path = await import('path');
      const read = (rel: string) =>
        fs.readFileSync(path.join(__dirname, '..', 'modules', rel), 'utf8');
      const signals = read('assist-site-learning/public/learning-signals.ts');
      expect(signals).toMatch(/ON CONFLICT DO NOTHING/);
      expect(signals).not.toMatch(/ON CONFLICT \(/);
      const goals = read('assist-analytics/public/goal-intake.service.ts');
      expect(goals).not.toMatch(/ON CONFLICT \(/);
      expect(goals.match(/skipDuplicates: true/g)?.length).toBe(2);
      for (const rel of [
        'assist-site-handoff/public/handoff-intake.service.ts',
        'assist-site-learning/public/forget-jobs.ts',
      ]) {
        expect(read(rel)).not.toMatch(/ON CONFLICT \(/);
      }
    });

    it('Э2: виджет читает статус хоста с блокировкой и пишет свои таблицы', async () => {
      await expect(
        asPublic(
          `SELECT "id", "siteId", "status", "expiresAt", "revokedAt", "reverifyBlockedAt" FROM ${S}."site_hosts" LIMIT 1`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(
          `SELECT "publicKey", "widgetVersion", "chatPaused", "operatorBlockedAt", "ipSalt", "allowClientPreview", "leadsConfig", "siteSummary" FROM ${S}."assist_sites" LIMIT 1`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(
          `INSERT INTO ${S}."assist_budget_days" ("scope", "key", "day", "updatedAt") VALUES ('site', 's', '2026-10-01', now()) ON CONFLICT DO NOTHING`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(
          `INSERT INTO ${S}."assist_landing_events" ("id", "name") VALUES ('e1', 'view')`,
        ),
      ).resolves.toBeUndefined();
    });

    it('Э1: публичная песочница пишет только свои таблицы и счётчики', async () => {
      await expect(
        asPublic(
          `INSERT INTO ${S}."assist_sandboxes" ("id", "kind", "url", "host", "registrableDomain", "pagesLimit", "questionsLimit", "expiresAt", "updatedAt") VALUES ('sb1', 'public', 'https://a.example/', 'a.example', 'a.example', 8, 10, now(), now())`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(
          `INSERT INTO ${S}."assist_daily_counters" ("scope", "key", "day", "value", "updatedAt") VALUES ('sandbox-ip', 'k', '2026-10-01', 1, now()) ON CONFLICT ("scope", "key", "day") DO UPDATE SET "value" = ${S}."assist_daily_counters"."value" + 1`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(`DELETE FROM ${S}."assist_sandboxes" WHERE false`),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('знания «Сайт» роль только читает: INSERT запрещён', async () => {
      await expect(
        asPublic(
          `INSERT INTO ${S}."assist_site_chunks" ("id", "siteId", "text") VALUES ('x', 'y', 'z')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('учёт расходов виджета: INSERT в site_ai_usage разрешён', async () => {
      await expect(
        asPublic(
          `INSERT INTO ${S}."site_ai_usage" ("id", "product", "provider", "operation", "model", "pricingVersion") VALUES ('u1', 'assist', 'GEMINI', 'assist-chat', 'm', 'v')`,
        ),
      ).resolves.toBeUndefined();
    });

    /**
     * Права роли — БЕЛЫМ списком по ВСЕМ таблицам схемы (аудит Э0): список
     * таблиц берётся из базы, а не руками, поэтому новая таблица следующей
     * миграции (как `site_account_invites`, `site_web_sessions` — с хешами
     * токенов) попадает в проверку сама. Любое право сверх списка — провал.
     */
    it('во всей схеме у assist_public нет прав сверх белого списка', async () => {
      const ALLOWED: Record<string, string[]> = {
        site_sites: ['SELECT'],
        // Только колоночный SELECT статусных полей (миграция _sites_core_init;
        // Э2 добавил reverifyBlockedAt для гварда origin).
        site_hosts: ['column:SELECT'],
        site_ai_usage: ['INSERT'],
        assist_site_chunks: ['SELECT'],
        // Э1 → Э2: поиск виджета/песочницы по опубликованной версии «Сайта».
        // Э2 сузил до колонок: черновики вида/персоны и настройки лидов — кабинету.
        assist_sites: ['column:SELECT'],
        assist_site_faq: ['column:SELECT'],
        // Э1: публичная песочница лендинга под этой ролью; Э2 сузил до
        // колонок (telegramId создателя, перенос, кабинет — не её).
        assist_sandboxes: ['column:SELECT', 'column:INSERT', 'column:UPDATE'],
        assist_sandbox_pages: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        assist_sandbox_chunks: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        assist_sandbox_messages: ['SELECT', 'INSERT'],
        assist_daily_counters: ['SELECT', 'INSERT', 'UPDATE'],
        site_crawl_robots: ['SELECT', 'INSERT', 'UPDATE'],
        // Отказ доменов (L0): только колонка domain.
        site_opt_out_domains: ['column:SELECT'],
        // Э2 (миграция _assist_widget): виджет «Сайта». Э3 (_assist_handoff)
        // сузил табличные UPDATE до колонок счётчиков и сроков.
        assist_site_config_versions: ['column:SELECT'],
        assist_site_visitor_resumes: [
          'SELECT',
          'INSERT',
          'DELETE',
          'column:UPDATE',
        ],
        assist_site_conversations: [
          'SELECT',
          'INSERT',
          'DELETE',
          'column:UPDATE',
        ],
        assist_site_messages: [
          'column:SELECT',
          'column:INSERT',
          'column:UPDATE',
        ],
        // Э3: + отвязка visitorId после forget и identify в шифре.
        assist_site_leads: ['column:SELECT', 'column:INSERT', 'column:UPDATE'],
        assist_budget_days: ['SELECT', 'INSERT', 'column:UPDATE'],
        assist_budget_reservations: ['SELECT', 'INSERT', 'DELETE'],
        // Э4 (миграция _assist_billing): тариф кабинета без секретов
        // продления, счётчик единиц (занять, мягкий стоп), рубильник платформы.
        assist_subscriptions: ['column:SELECT'],
        assist_account_usage: ['SELECT', 'column:INSERT', 'column:UPDATE'],
        assist_platform_settings: ['column:SELECT'],
        assist_rate_buckets: ['SELECT', 'INSERT', 'column:UPDATE'],
        assist_site_semantic_cache: [
          'SELECT',
          'INSERT',
          'DELETE',
          'column:UPDATE',
        ],
        assist_site_preview_tokens: ['column:SELECT', 'column:UPDATE'],
        assist_site_install_pings: ['SELECT', 'INSERT', 'column:UPDATE'],
        assist_site_assets: ['column:SELECT'],
        // Э3 (миграция _assist_handoff): передача, очередь, цели, счётчики.
        assist_site_handoffs: [
          'column:SELECT',
          'column:INSERT',
          'column:UPDATE',
        ],
        assist_site_learning_items: ['column:INSERT'],
        assist_site_forget_jobs: ['INSERT'],
        assist_site_goals: ['column:SELECT'],
        assist_site_goal_events: ['INSERT'],
        assist_site_event_counts: ['SELECT', 'INSERT', 'column:UPDATE'],
        // Э5 (миграция _assist_voice): кэш озвучки — чтение своей записи
        // и вставка без цели конфликта.
        assist_site_tts_cache: ['column:SELECT', 'column:INSERT'],
        // Э6 (миграция _assist_video_highlight): ролики сайта — только
        // чтение колонок показа и ссылки; карта интерфейса — элементы
        // страницы и счётчик промахов «карта устарела».
        assist_site_videos: ['column:SELECT'],
        site_ui_maps: ['column:SELECT', 'column:UPDATE'],
        // Лендинг: только запись.
        assist_widget_drafts: ['INSERT'],
        assist_landing_events: ['INSERT'],
      };
      const TABLE_PRIVS = [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ];
      const COLUMN_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
      const { rows } = await client.query<{ t: string }>(
        `SELECT tablename AS t FROM pg_tables WHERE schemaname = $1 ORDER BY 1`,
        [SITES_DB_SCHEMA],
      );
      const tables = rows.map((r) => r.t);
      // Не пустая проверка: таблицы с токенами сессий/приглашений — в ней.
      expect(tables).toEqual(
        expect.arrayContaining([
          'site_web_sessions',
          'site_account_invites',
          'assist_admin_chunks',
          'assist_admin_settings',
          'site_pages',
          'assist_sandboxes',
        ]),
      );
      const actual: Record<string, string[]> = {};
      for (const t of tables) {
        const rel = `${S}."${t}"`;
        const got: string[] = [];
        for (const p of TABLE_PRIVS) {
          const r = await client.query<{ ok: boolean }>(
            `SELECT has_table_privilege('assist_public', $1, $2) AS ok`,
            [rel, p],
          );
          if (r.rows[0].ok) got.push(p);
        }
        for (const p of COLUMN_PRIVS) {
          if (got.includes(p)) continue;
          const r = await client.query<{ ok: boolean }>(
            `SELECT has_any_column_privilege('assist_public', $1, $2) AS ok`,
            [rel, p],
          );
          if (r.rows[0].ok) got.push(`column:${p}`);
        }
        if (got.length > 0 || ALLOWED[t]) actual[t] = got;
      }
      expect(actual).toEqual(ALLOWED);
    });

    /**
     * Глобальный `omit` публичного клиента (ASSIST_PUBLIC_OMIT) обязан
     * совпадать с колоночными правами: лишняя колонка в omit — тихо пустое
     * поле, недостающая — 42501 на каждом запросе без select.
     */
    it('Э2: ASSIST_PUBLIC_OMIT = колонки без SELECT у роли', async () => {
      const models = Prisma.dmmf.datamodel.models;
      for (const [key, omitted] of Object.entries(ASSIST_PUBLIC_OMIT)) {
        const model = models.find(
          (m) => m.name.charAt(0).toLowerCase() + m.name.slice(1) === key,
        );
        expect(model).toBeDefined();
        const table = model!.dbName ?? model!.name;
        const closed: string[] = [];
        for (const f of model!.fields) {
          if (f.kind === 'object') continue;
          const r = await client.query<{ ok: boolean }>(
            `SELECT has_column_privilege('assist_public', $1, $2, 'SELECT') AS ok`,
            [`${S}."${table}"`, f.dbName ?? f.name],
          );
          if (!r.rows[0].ok) closed.push(f.name);
        }
        expect(closed.sort()).toEqual(Object.keys(omitted).sort());
      }
    });

    it('роль не может войти сама (NOLOGIN)', async () => {
      const r = await client.query(
        `SELECT rolcanlogin FROM pg_roles WHERE rolname = 'assist_public'`,
      );
      expect(r.rows).toEqual([{ rolcanlogin: false }]);
    });
  });

  describe('кабинеты на реальной базе: адаптер со схемой sites + тенант', () => {
    const prisma = new PrismaClient({
      adapter: new PrismaPg(url, { schema: SITES_DB_SCHEMA }),
    });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const A = `e0-acc-a-${suffix}`;
    const B = `e0-acc-b-${suffix}`;

    beforeAll(async () => {
      for (const id of [A, B]) {
        await prisma.siteAccount.create({
          data: { id, verifyToken: `tok-${id}` },
        });
        await prisma.site.create({
          data: { id: `site-${id}`, accountId: id, name: `Сайт ${id}` },
        });
      }
    });

    afterAll(async () => {
      await prisma.siteAccount.deleteMany({ where: { id: { in: [A, B] } } });
      await prisma.$disconnect();
    });

    it('forAccount(A) видит только сайты кабинета A', async () => {
      const db = prisma.$extends(tenantExtension(A));
      const sites = await db.site.findMany({
        where: { id: { startsWith: 'site-e0-acc-' } },
      });
      expect(sites.map((s) => s.accountId)).toEqual([A]);
    });

    it('дубль хоста в кабинете отклоняется, в другом кабинете — можно', async () => {
      const host = { scheme: 'https', host: 'example.com', port: 443 };
      await prisma.siteHost.create({
        data: { ...host, accountId: A, siteId: `site-${A}` },
      });
      await expect(
        prisma.siteHost.create({
          data: { ...host, accountId: A, siteId: `site-${A}` },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        prisma.siteHost.create({
          data: { ...host, accountId: B, siteId: `site-${B}` },
        }),
      ).resolves.toMatchObject({ accountId: B });
    });

    it('хост кабинета A нельзя привязать к сайту кабинета B (составной FK)', async () => {
      await expect(
        prisma.siteHost.create({
          data: {
            scheme: 'https',
            host: 'shop.example.com',
            port: 443,
            accountId: A,
            siteId: `site-${B}`,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });
  });
}
