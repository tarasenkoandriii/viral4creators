-- Э1 ИИ-помощника «Знания»: обход (site-crawl, общий с QA), знания «Сайт» и
-- «Админка» раздельными наборами таблиц, версии базы, FAQ, исключения,
-- eval «Сайта», песочница (в т.ч. публичная для лендинга), бюджет обучения,
-- замки кронов. ТЗ помощника §4.3, §4.3-бис, §4.17, §4-тер.2, §4-тер.14;
-- лендинг-ТЗ §6; контракт Э1 (/tmp/k/CONTRACT-E1.md).
--
-- Пишется РУКАМИ (база — вывод движка схем, дальше правки и комментарии);
-- CI сверяет со schema.prisma (`migrate diff --exit-code`). Предыдущие
-- миграции не трогаем: они уже могли накатиться на стенд.
--
-- ── Что Prisma НЕ описывает и почему diff это не видит ─────────────────
-- Проверено движком схем Prisma 7.10 (wasm-сборка с адаптером pg) на
-- Postgres 16 + pgvector:
--  * HNSW по embedding — `type: Hnsw` у Prisma нет, а обычный индекс на
--    колонке, которой нет в schema.prisma как индекса, diff предлагает
--    УДАЛИТЬ (DROP INDEX). Частичные индексы (`WHERE …`) движок без
--    preview-флага `partialIndexes` не читает вовсе — поэтому HNSW здесь
--    частичный: `WHERE "embedding" IS NOT NULL`. Это ещё и по смыслу:
--    фрагмент без вектора (ждёт эмбеддинга) в индексе не нужен. Запрос
--    поиска обязан повторять условие `"embedding" IS NOT NULL`, иначе
--    планировщик индекс не возьмёт. ВКЛЮЧИТЬ `partialIndexes` в
--    schema.prisma = diff увидит индекс и потребует его описать.
--  * Полнотекстовый индекс — по выражению `to_tsvector('simple', text)`:
--    индексы по выражению движок тоже пропускает. Запрос обязан
--    использовать ТО ЖЕ выражение.
--  * Триграммный GIN по text — описан в schema.prisma (`ops: raw(…)`) и
--    сверяется diff'ом как обычно.
--
-- ── Квалификация имён ──────────────────────────────────────────────────
-- migrate ставит search_path = sites; расширения живут в `extensions`
-- (Supabase), поэтому классы операторов и типы названы полностью. Сырой SQL
-- приложения — так же: `"sites"."таблица"`, `OPERATOR("extensions".<=>)`,
-- `"extensions".similarity(…)` (адаптер search_path не ставит,
-- src/prisma/prisma.service.ts).

-- ── pg_trgm ─────────────────────────────────────────────────────────────
-- На Supabase pg_trgm может уже стоять — IF NOT EXISTS. ПРОВЕРИТЬ до
-- деплоя, в какой схеме он там: `SELECT extnamespace::regnamespace FROM
-- pg_extension WHERE extname = 'pg_trgm'` — должно быть `extensions`
-- (иначе ниже не найдётся "extensions"."gin_trgm_ops"; см. doc/DEPLOYMENT.md).
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "extensions";

-- ── Фрагменты Э0 → полная форма Э1 ──────────────────────────────────────
-- В Э0 у таблиц фрагментов не было ни одного писателя (конвейер индексации —
-- этот этап), а фрагменты — производные данные, пересобираемые из
-- источников. Очищаем, чтобы добавить обязательные колонки без умолчаний.
TRUNCATE TABLE "assist_site_chunks", "assist_admin_chunks";

-- DropForeignKey
ALTER TABLE "assist_admin_chunks" DROP CONSTRAINT "assist_admin_chunks_siteId_fkey";

-- DropForeignKey
ALTER TABLE "assist_site_chunks" DROP CONSTRAINT "assist_site_chunks_siteId_fkey";

-- AlterTable
ALTER TABLE "assist_admin_chunks" ADD COLUMN     "accountId" TEXT NOT NULL,
ADD COLUMN     "contentHash" TEXT NOT NULL,
ADD COLUMN     "digitsMaskedHash" TEXT NOT NULL,
ADD COLUMN     "documentId" TEXT NOT NULL,
ADD COLUMN     "embedModel" TEXT,
ADD COLUMN     "embeddedAt" TIMESTAMP(3),
ADD COLUMN     "headingPath" TEXT,
ADD COLUMN     "lang" TEXT,
ADD COLUMN     "ordinal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quarantineAllowedAt" TIMESTAMP(3),
ADD COLUMN     "quarantineAllowedByTelegramId" BIGINT,
ADD COLUMN     "quarantineReason" TEXT,
ADD COLUMN     "quarantined" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceType" TEXT NOT NULL,
ADD COLUMN     "title" TEXT,
ADD COLUMN     "tokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ugc" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "url" TEXT,
ADD COLUMN     "versions" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "assist_site_chunks" ADD COLUMN     "accountId" TEXT NOT NULL,
ADD COLUMN     "contentHash" TEXT NOT NULL,
ADD COLUMN     "digitsMaskedHash" TEXT NOT NULL,
ADD COLUMN     "documentId" TEXT NOT NULL,
ADD COLUMN     "embedModel" TEXT,
ADD COLUMN     "embeddedAt" TIMESTAMP(3),
ADD COLUMN     "headingPath" TEXT,
ADD COLUMN     "lang" TEXT,
ADD COLUMN     "ordinal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quarantineAllowedAt" TIMESTAMP(3),
ADD COLUMN     "quarantineAllowedByTelegramId" BIGINT,
ADD COLUMN     "quarantineReason" TEXT,
ADD COLUMN     "quarantined" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceType" TEXT NOT NULL,
ADD COLUMN     "title" TEXT,
ADD COLUMN     "tokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ugc" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "url" TEXT,
ADD COLUMN     "versions" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- CreateTable
CREATE TABLE "site_cron_locks" (
    "jobKey" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "holder" TEXT,
    "lastStartedAt" TIMESTAMP(3),
    "lastFinishedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "site_cron_locks_pkey" PRIMARY KEY ("jobKey")
);

-- CreateTable
CREATE TABLE "site_pages" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "finalUrl" TEXT,
    "httpStatus" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'new',
    "skipReason" TEXT,
    "title" TEXT,
    "lang" TEXT,
    "text" TEXT,
    "blocks" JSONB,
    "contentHash" TEXT,
    "etag" TEXT,
    "lastModified" TEXT,
    "sitemapLastmod" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'seed',
    "depth" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3),
    "changedAt" TIMESTAMP(3),
    "goneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_crawl_runs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'full',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "maxPages" INTEGER NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "pagesSeen" INTEGER NOT NULL DEFAULT 0,
    "pagesChanged" INTEGER NOT NULL DEFAULT 0,
    "pagesUnchanged" INTEGER NOT NULL DEFAULT 0,
    "pagesSkipped" INTEGER NOT NULL DEFAULT 0,
    "pagesFailed" INTEGER NOT NULL DEFAULT 0,
    "pagesGone" INTEGER NOT NULL DEFAULT 0,
    "stats" JSONB,
    "lockedUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requestedByTelegramId" BIGINT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_crawl_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_crawl_queue" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lockedUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_crawl_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_crawl_robots" (
    "origin" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "body" TEXT,
    "sitemaps" TEXT[],
    "crawlDelayMs" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_crawl_robots_pkey" PRIMARY KEY ("origin")
);

-- CreateTable
CREATE TABLE "assist_sites" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "knowledgeVersion" INTEGER NOT NULL DEFAULT 0,
    "configVersion" INTEGER NOT NULL DEFAULT 0,
    "versionSeq" INTEGER NOT NULL DEFAULT 0,
    "recrawlEvery" TEXT NOT NULL DEFAULT 'weekly',
    "nextCrawlAt" TIMESTAMP(3),
    "lastCrawlRunId" TEXT,
    "lastIndexedCrawlRunId" TEXT,
    "hotPages" TEXT[],
    "hotCheckedAt" TIMESTAMP(3),
    "learningShareBp" INTEGER,
    "suggestedQuestions" JSONB,
    "suggestedForVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_learning_spend" (
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "spentMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_learning_spend_pkey" PRIMARY KEY ("siteId","period")
);

-- CreateTable
CREATE TABLE "assist_daily_counters" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_daily_counters_pkey" PRIMARY KEY ("scope","key","day")
);

-- CreateTable
CREATE TABLE "assist_sandboxes" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "accountId" TEXT,
    "siteId" TEXT,
    "createdByTelegramId" BIGINT,
    "browserKeyHash" TEXT,
    "url" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "registrableDomain" TEXT NOT NULL,
    "ipKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "statusReason" TEXT,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "title" TEXT,
    "lang" TEXT,
    "themeColor" TEXT,
    "pagesLimit" INTEGER NOT NULL,
    "pagesRead" INTEGER NOT NULL DEFAULT 0,
    "questionsLimit" INTEGER NOT NULL,
    "questions" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "suggestedQuestions" JSONB,
    "screenshotKey" TEXT,
    "reusedFromId" TEXT,
    "transferredAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_sandboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_sandbox_pages" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "lang" TEXT,
    "text" TEXT NOT NULL,
    "blocks" JSONB,
    "contentHash" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_sandbox_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_sandbox_chunks" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "headingPath" TEXT,
    "lang" TEXT,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT NOT NULL,
    "ugc" BOOLEAN NOT NULL DEFAULT false,
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "quarantineReason" TEXT,
    "embedModel" TEXT,
    "embedding" "extensions"."vector"(768),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_sandbox_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_sandbox_messages" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sources" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_sandbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_sources" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "error" TEXT,
    "blobPathname" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "bytes" INTEGER,
    "sha256" TEXT,
    "publicConfirmedAt" TIMESTAMP(3),
    "documentsCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdByTelegramId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_documents" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT,
    "sitePageId" TEXT,
    "title" TEXT,
    "lang" TEXT,
    "contentHash" TEXT,
    "indexedHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "skipReason" TEXT,
    "hot" BOOLEAN NOT NULL DEFAULT false,
    "goneAt" TIMESTAMP(3),
    "indexedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_knowledge_versions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'building',
    "parentNumber" INTEGER,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "gateReport" JSONB,
    "heldReason" TEXT,
    "evalRunId" TEXT,
    "crawlRunId" TEXT,
    "createdByTelegramId" BIGINT,
    "publishedByTelegramId" BIGINT,
    "checkedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "discardedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_knowledge_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_faq" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "variants" TEXT[],
    "lang" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'owner',
    "sourceRefs" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "approvedByTelegramId" BIGINT,
    "approvedAt" TIMESTAMP(3),
    "reviewAt" TIMESTAMP(3),
    "conflictNote" TEXT,
    "fromConversationId" TEXT,
    "documentId" TEXT,
    "createdByTelegramId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_faq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_exclusions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "createdByTelegramId" BIGINT NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "chunksDeleted" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_exclusions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_eval_cases" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "expected" TEXT,
    "mustCite" TEXT[],
    "mustNotSay" TEXT[],
    "lang" TEXT,
    "sourceChunkHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_eval_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_eval_runs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "knowledgeVersion" INTEGER,
    "model" TEXT NOT NULL,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "stale" INTEGER NOT NULL DEFAULT 0,
    "report" JSONB NOT NULL DEFAULT '{}',
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_settings" (
    "siteId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "includePublicInAdmin" BOOLEAN NOT NULL DEFAULT true,
    "includeUgcInAdmin" BOOLEAN NOT NULL DEFAULT false,
    "knowledgeVersion" INTEGER NOT NULL DEFAULT 0,
    "configVersion" INTEGER NOT NULL DEFAULT 0,
    "versionSeq" INTEGER NOT NULL DEFAULT 0,
    "lastIndexedCrawlRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_settings_pkey" PRIMARY KEY ("siteId")
);

-- CreateTable
CREATE TABLE "assist_admin_sources" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "error" TEXT,
    "blobPathname" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "bytes" INTEGER,
    "sha256" TEXT,
    "documentsCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdByTelegramId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_documents" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT,
    "sitePageId" TEXT,
    "title" TEXT,
    "lang" TEXT,
    "contentHash" TEXT,
    "indexedHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "skipReason" TEXT,
    "hot" BOOLEAN NOT NULL DEFAULT false,
    "goneAt" TIMESTAMP(3),
    "indexedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_knowledge_versions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'building',
    "parentNumber" INTEGER,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "gateReport" JSONB,
    "heldReason" TEXT,
    "evalRunId" TEXT,
    "crawlRunId" TEXT,
    "createdByTelegramId" BIGINT,
    "publishedByTelegramId" BIGINT,
    "checkedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "discardedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_admin_knowledge_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_faq" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "variants" TEXT[],
    "lang" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'owner',
    "sourceRefs" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "approvedByTelegramId" BIGINT,
    "approvedAt" TIMESTAMP(3),
    "reviewAt" TIMESTAMP(3),
    "conflictNote" TEXT,
    "fromConversationId" TEXT,
    "documentId" TEXT,
    "createdByTelegramId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_faq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_exclusions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "createdByTelegramId" BIGINT NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "chunksDeleted" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_admin_exclusions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_pages_siteId_changedAt_idx" ON "site_pages"("siteId", "changedAt");

-- CreateIndex
CREATE INDEX "site_pages_accountId_idx" ON "site_pages"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "site_pages_hostId_url_key" ON "site_pages"("hostId", "url");

-- CreateIndex
CREATE INDEX "site_crawl_runs_status_lockedUntil_idx" ON "site_crawl_runs"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "site_crawl_runs_siteId_createdAt_idx" ON "site_crawl_runs"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "site_crawl_runs_accountId_idx" ON "site_crawl_runs"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "site_crawl_runs_id_accountId_key" ON "site_crawl_runs"("id", "accountId");

-- CreateIndex
CREATE INDEX "site_crawl_queue_runId_status_priority_idx" ON "site_crawl_queue"("runId", "status", "priority");

-- CreateIndex
CREATE INDEX "site_crawl_queue_accountId_idx" ON "site_crawl_queue"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "site_crawl_queue_runId_url_key" ON "site_crawl_queue"("runId", "url");

-- CreateIndex
CREATE INDEX "site_crawl_robots_expiresAt_idx" ON "site_crawl_robots"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "assist_sites_siteId_key" ON "assist_sites"("siteId");

-- CreateIndex
CREATE INDEX "assist_sites_accountId_idx" ON "assist_sites"("accountId");

-- CreateIndex
CREATE INDEX "assist_sites_nextCrawlAt_idx" ON "assist_sites"("nextCrawlAt");

-- CreateIndex
CREATE UNIQUE INDEX "assist_sites_siteId_accountId_key" ON "assist_sites"("siteId", "accountId");

-- CreateIndex
CREATE INDEX "assist_learning_spend_accountId_period_idx" ON "assist_learning_spend"("accountId", "period");

-- CreateIndex
CREATE INDEX "assist_daily_counters_day_idx" ON "assist_daily_counters"("day");

-- CreateIndex
CREATE INDEX "assist_sandboxes_registrableDomain_createdAt_idx" ON "assist_sandboxes"("registrableDomain", "createdAt");

-- CreateIndex
CREATE INDEX "assist_sandboxes_ipKey_createdAt_idx" ON "assist_sandboxes"("ipKey", "createdAt");

-- CreateIndex
CREATE INDEX "assist_sandboxes_siteId_idx" ON "assist_sandboxes"("siteId");

-- CreateIndex
CREATE INDEX "assist_sandboxes_status_lockedUntil_idx" ON "assist_sandboxes"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "assist_sandboxes_expiresAt_idx" ON "assist_sandboxes"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "assist_sandbox_pages_sandboxId_url_key" ON "assist_sandbox_pages"("sandboxId", "url");

-- CreateIndex
CREATE INDEX "assist_sandbox_chunks_sandboxId_idx" ON "assist_sandbox_chunks"("sandboxId");

-- CreateIndex
CREATE INDEX "assist_sandbox_messages_sandboxId_createdAt_idx" ON "assist_sandbox_messages"("sandboxId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_sources_siteId_idx" ON "assist_site_sources"("siteId");

-- CreateIndex
CREATE INDEX "assist_site_sources_status_lockedUntil_idx" ON "assist_site_sources"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "assist_site_sources_accountId_idx" ON "assist_site_sources"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_sources_id_accountId_key" ON "assist_site_sources"("id", "accountId");

-- CreateIndex
CREATE INDEX "assist_site_documents_siteId_status_idx" ON "assist_site_documents"("siteId", "status");

-- CreateIndex
CREATE INDEX "assist_site_documents_accountId_idx" ON "assist_site_documents"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_documents_sourceId_ref_key" ON "assist_site_documents"("sourceId", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_documents_id_accountId_key" ON "assist_site_documents"("id", "accountId");

-- CreateIndex
CREATE INDEX "assist_site_knowledge_versions_siteId_status_idx" ON "assist_site_knowledge_versions"("siteId", "status");

-- CreateIndex
CREATE INDEX "assist_site_knowledge_versions_accountId_idx" ON "assist_site_knowledge_versions"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_knowledge_versions_siteId_number_key" ON "assist_site_knowledge_versions"("siteId", "number");

-- CreateIndex
CREATE INDEX "assist_site_faq_siteId_status_idx" ON "assist_site_faq"("siteId", "status");

-- CreateIndex
CREATE INDEX "assist_site_faq_accountId_idx" ON "assist_site_faq"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_exclusions_accountId_idx" ON "assist_site_exclusions"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_exclusions_siteId_kind_value_key" ON "assist_site_exclusions"("siteId", "kind", "value");

-- CreateIndex
CREATE INDEX "assist_site_eval_cases_siteId_status_idx" ON "assist_site_eval_cases"("siteId", "status");

-- CreateIndex
CREATE INDEX "assist_site_eval_cases_accountId_idx" ON "assist_site_eval_cases"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_eval_runs_siteId_createdAt_idx" ON "assist_site_eval_runs"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_eval_runs_accountId_idx" ON "assist_site_eval_runs"("accountId");

-- CreateIndex
CREATE INDEX "assist_admin_settings_accountId_idx" ON "assist_admin_settings"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_settings_siteId_accountId_key" ON "assist_admin_settings"("siteId", "accountId");

-- CreateIndex
CREATE INDEX "assist_admin_sources_siteId_idx" ON "assist_admin_sources"("siteId");

-- CreateIndex
CREATE INDEX "assist_admin_sources_status_lockedUntil_idx" ON "assist_admin_sources"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "assist_admin_sources_accountId_idx" ON "assist_admin_sources"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_sources_id_accountId_key" ON "assist_admin_sources"("id", "accountId");

-- CreateIndex
CREATE INDEX "assist_admin_documents_siteId_status_idx" ON "assist_admin_documents"("siteId", "status");

-- CreateIndex
CREATE INDEX "assist_admin_documents_accountId_idx" ON "assist_admin_documents"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_documents_sourceId_ref_key" ON "assist_admin_documents"("sourceId", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_documents_id_accountId_key" ON "assist_admin_documents"("id", "accountId");

-- CreateIndex
CREATE INDEX "assist_admin_knowledge_versions_siteId_status_idx" ON "assist_admin_knowledge_versions"("siteId", "status");

-- CreateIndex
CREATE INDEX "assist_admin_knowledge_versions_accountId_idx" ON "assist_admin_knowledge_versions"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_knowledge_versions_siteId_number_key" ON "assist_admin_knowledge_versions"("siteId", "number");

-- CreateIndex
CREATE INDEX "assist_admin_faq_siteId_status_idx" ON "assist_admin_faq"("siteId", "status");

-- CreateIndex
CREATE INDEX "assist_admin_faq_accountId_idx" ON "assist_admin_faq"("accountId");

-- CreateIndex
CREATE INDEX "assist_admin_exclusions_accountId_idx" ON "assist_admin_exclusions"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_exclusions_siteId_kind_value_key" ON "assist_admin_exclusions"("siteId", "kind", "value");

-- CreateIndex
CREATE INDEX "assist_admin_chunks_documentId_idx" ON "assist_admin_chunks"("documentId");

-- CreateIndex
CREATE INDEX "assist_admin_chunks_siteId_contentHash_idx" ON "assist_admin_chunks"("siteId", "contentHash");

-- CreateIndex
CREATE INDEX "assist_admin_chunks_accountId_idx" ON "assist_admin_chunks"("accountId");

-- CreateIndex
CREATE INDEX "assist_admin_chunks_text_idx" ON "assist_admin_chunks" USING GIN ("text" "extensions"."gin_trgm_ops");

-- CreateIndex
CREATE INDEX "assist_site_chunks_documentId_idx" ON "assist_site_chunks"("documentId");

-- CreateIndex
CREATE INDEX "assist_site_chunks_siteId_contentHash_idx" ON "assist_site_chunks"("siteId", "contentHash");

-- CreateIndex
CREATE INDEX "assist_site_chunks_accountId_idx" ON "assist_site_chunks"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_chunks_text_idx" ON "assist_site_chunks" USING GIN ("text" "extensions"."gin_trgm_ops");

-- AddForeignKey
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_hostId_accountId_fkey" FOREIGN KEY ("hostId", "accountId") REFERENCES "site_hosts"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_crawl_runs" ADD CONSTRAINT "site_crawl_runs_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_crawl_queue" ADD CONSTRAINT "site_crawl_queue_runId_accountId_fkey" FOREIGN KEY ("runId", "accountId") REFERENCES "site_crawl_runs"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_sites" ADD CONSTRAINT "assist_sites_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_learning_spend" ADD CONSTRAINT "assist_learning_spend_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_sandboxes" ADD CONSTRAINT "assist_sandboxes_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_sandbox_pages" ADD CONSTRAINT "assist_sandbox_pages_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "assist_sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_sandbox_chunks" ADD CONSTRAINT "assist_sandbox_chunks_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "assist_sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_sandbox_chunks" ADD CONSTRAINT "assist_sandbox_chunks_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "assist_sandbox_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_sandbox_messages" ADD CONSTRAINT "assist_sandbox_messages_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "assist_sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_sources" ADD CONSTRAINT "assist_site_sources_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_documents" ADD CONSTRAINT "assist_site_documents_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_documents" ADD CONSTRAINT "assist_site_documents_sourceId_accountId_fkey" FOREIGN KEY ("sourceId", "accountId") REFERENCES "assist_site_sources"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_chunks" ADD CONSTRAINT "assist_site_chunks_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_chunks" ADD CONSTRAINT "assist_site_chunks_documentId_accountId_fkey" FOREIGN KEY ("documentId", "accountId") REFERENCES "assist_site_documents"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_knowledge_versions" ADD CONSTRAINT "assist_site_knowledge_versions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_faq" ADD CONSTRAINT "assist_site_faq_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_exclusions" ADD CONSTRAINT "assist_site_exclusions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_eval_cases" ADD CONSTRAINT "assist_site_eval_cases_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_eval_runs" ADD CONSTRAINT "assist_site_eval_runs_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_settings" ADD CONSTRAINT "assist_admin_settings_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_sources" ADD CONSTRAINT "assist_admin_sources_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_documents" ADD CONSTRAINT "assist_admin_documents_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_documents" ADD CONSTRAINT "assist_admin_documents_sourceId_accountId_fkey" FOREIGN KEY ("sourceId", "accountId") REFERENCES "assist_admin_sources"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_chunks" ADD CONSTRAINT "assist_admin_chunks_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_chunks" ADD CONSTRAINT "assist_admin_chunks_documentId_accountId_fkey" FOREIGN KEY ("documentId", "accountId") REFERENCES "assist_admin_documents"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_knowledge_versions" ADD CONSTRAINT "assist_admin_knowledge_versions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_faq" ADD CONSTRAINT "assist_admin_faq_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_exclusions" ADD CONSTRAINT "assist_admin_exclusions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Индексы, которых нет в schema.prisma (см. заголовок) ────────────────

-- HNSW, косинусная мера: поиск `ORDER BY "embedding" OPERATOR("extensions".<=>) $q`
-- c `WHERE "siteId" = $1 AND "embedding" IS NOT NULL`. Свой индекс у
-- каждого режима и у песочницы нет (там сотни фрагментов на песочницу —
-- точный перебор по sandboxId дешевле).
CREATE INDEX "assist_site_chunks_embedding_hnsw" ON "assist_site_chunks"
  USING hnsw ("embedding" "extensions"."vector_cosine_ops")
  WHERE "embedding" IS NOT NULL;
CREATE INDEX "assist_admin_chunks_embedding_hnsw" ON "assist_admin_chunks"
  USING hnsw ("embedding" "extensions"."vector_cosine_ops")
  WHERE "embedding" IS NOT NULL;

-- Полнотекст: конфигурация 'simple' — языки uk/ru/en в одном индексе без
-- стемминга (стеммера украинского в Postgres нет; артикулы и коды — как есть).
CREATE INDEX "assist_site_chunks_fts" ON "assist_site_chunks"
  USING gin (to_tsvector('simple'::regconfig, "text"));
CREATE INDEX "assist_admin_chunks_fts" ON "assist_admin_chunks"
  USING gin (to_tsvector('simple'::regconfig, "text"));

-- ── Роль assist_public (ТЗ §4.3-бис слой 3, §4.17, §4-тер.14) ────────────
-- Правило Э0 — «ничего по умолчанию, явный список». Новое:
--  * знания «Сайта» для поиска виджета/песочницы — только чтение:
--    assist_sites (опубликованная версия; секретов «Админки» там нет, У-10),
--    assist_site_faq; assist_site_chunks — SELECT уже выдан в Э0;
--  * публичная песочница лендинга ходит в базу ЭТОЙ ролью целиком
--    (анонимный маршрут — как виджет): свои таблицы песочницы, суточные
--    счётчики лимитов, кэш robots, отказ доменов (только колонка domain);
--  * НИЧЕГО на assist_admin_*, site_pages, site_crawl_runs/queue,
--    assist_site_sources/documents/knowledge_versions/exclusions/eval_*,
--    assist_learning_spend, site_cron_locks.
GRANT SELECT ON "assist_sites" TO assist_public;
GRANT SELECT ON "assist_site_faq" TO assist_public;
GRANT SELECT, INSERT, UPDATE ON "assist_sandboxes" TO assist_public;
GRANT SELECT, INSERT, UPDATE, DELETE ON "assist_sandbox_pages" TO assist_public;
GRANT SELECT, INSERT, UPDATE, DELETE ON "assist_sandbox_chunks" TO assist_public;
GRANT SELECT, INSERT ON "assist_sandbox_messages" TO assist_public;
GRANT SELECT, INSERT, UPDATE ON "assist_daily_counters" TO assist_public;
GRANT SELECT, INSERT, UPDATE ON "site_crawl_robots" TO assist_public;
-- Prisma 7 в findFirst всегда выбирает и "id" — без него 42501.
GRANT SELECT ("id", "domain") ON "site_opt_out_domains" TO assist_public;
