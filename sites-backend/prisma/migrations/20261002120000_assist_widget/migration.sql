-- Э2 ИИ-помощника «MVP: режим „Сайт“ текстом» — виджет на сайте заказчика.
-- ТЗ помощника §3-бис, §3.5–§3.6, §4-бис, §4.5, §4.12–§4.13, §4.17,
-- §4-тер.9, §6.3; лендинг-ТЗ §5.3, §7.3, §10.1; контракт Э2
-- (/tmp/k/CONTRACT-E2.md).
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma 7.10, дальше правки и
-- комментарии); CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.
--
-- Что здесь:
--  * assist_sites: ключи pk_live_/pk_test_, версия вида, черновики вида и
--    персоны, настройки лидов, рубильники (владелец/оператор), флаг
--    allowClientPreview (лендинг, «к Л2»), суточный потолок, соль ipHash,
--    сроки хранения. Новые колонки — без обязательных значений: строки Э1
--    остаются валидными, ключи выдаёт кабинет при первой настройке виджета.
--  * Новые таблицы режима «Сайт»: версии вида/персоны, указатели
--    посетителя (resumeKey, §4-бис.3), диалоги, сообщения (маскированные),
--    лиды, счётчик диалогов периода, семантический кэш, токены
--    предпросмотра, пинги установки, картинки бренда (растр), мастер
--    «Научите помощника»; в assist_sites — сводка сайта (§4.6 п.3).
--  * Вне тенанта: деньги дня и резервы с TTL (§4.5), окна лимитов частоты.
--  * Лендинг: анонимные черновики вида (`wd_`, «к Л3»), атрибуция
--    (assist_acquisitions), первичные события лендинга.
--  * GRANT роли assist_public — в конце, с причиной у каждой строки;
--    плюс СУЖЕНИЕ отложенных из Э1 прав на assist_site_faq и
--    assist_sandboxes и перевод assist_sites на колоночный SELECT.

-- AlterTable
ALTER TABLE "assist_sites" ADD COLUMN     "allowClientPreview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "chatPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dailyCapMicroUsd" INTEGER,
ADD COLUMN     "ipSalt" TEXT,
ADD COLUMN     "leadRetentionDays" INTEGER NOT NULL DEFAULT 180,
ADD COLUMN     "leadsConfig" JSONB,
ADD COLUMN     "operatorBlockedAt" TIMESTAMP(3),
ADD COLUMN     "personaDraft" JSONB,
ADD COLUMN     "publicKey" TEXT,
ADD COLUMN     "retentionDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "siteSummary" JSONB,
ADD COLUMN     "siteSummaryVersion" INTEGER,
ADD COLUMN     "testKey" TEXT,
ADD COLUMN     "widgetDraft" JSONB,
ADD COLUMN     "widgetVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "assist_site_config_versions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "gateReport" JSONB,
    "rolledBackFrom" INTEGER,
    "publishedByTelegramId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_config_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_visitor_resumes" (
    "keyHash" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "parentOrigin" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_visitor_resumes_pkey" PRIMARY KEY ("keyHash")
);

-- CreateTable
CREATE TABLE "assist_site_conversations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "parentOrigin" TEXT NOT NULL,
    "pageUrl" TEXT,
    "locale" TEXT,
    "dialogCounted" BOOLEAN NOT NULL DEFAULT false,
    "answers" INTEGER NOT NULL DEFAULT 0,
    "suspicious" BOOLEAN NOT NULL DEFAULT false,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT,
    "handoffState" TEXT,
    "activePlanId" TEXT,
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_messages" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sources" JSONB,
    "actions" JSONB,
    "flags" TEXT[],
    "clientRequestId" TEXT,
    "streamState" TEXT NOT NULL DEFAULT 'complete',
    "streamOffset" INTEGER NOT NULL DEFAULT 0,
    "answerPath" TEXT,
    "cacheKey" TEXT,
    "rating" INTEGER,
    "inTokens" INTEGER NOT NULL DEFAULT 0,
    "outTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_leads" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "conversationId" TEXT,
    "visitorId" TEXT,
    "fieldsEnc" TEXT NOT NULL,
    "fieldNames" TEXT[],
    "consentText" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "pageUrl" TEXT,
    "deliveryState" TEXT NOT NULL DEFAULT 'pending',
    "deliveredTo" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_budget_days" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "spentMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "reservedMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_budget_days_pkey" PRIMARY KEY ("scope","key","day")
);

-- CreateTable
CREATE TABLE "assist_budget_reservations" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "estMicroUsd" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_budget_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_period_usage" (
    "siteId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "dialogs" INTEGER NOT NULL DEFAULT 0,
    "quota" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_period_usage_pkey" PRIMARY KEY ("siteId","period")
);

-- CreateTable
CREATE TABLE "assist_site_semantic_cache" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "answer" JSONB NOT NULL,
    "knowledgeVersion" INTEGER NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_semantic_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_rate_buckets" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_rate_buckets_pkey" PRIMARY KEY ("scope","key","bucket")
);

-- CreateTable
CREATE TABLE "assist_site_preview_tokens" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "origin" TEXT,
    "draft" JSONB,
    "createdByTelegramId" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "sessionHash" TEXT,
    "sessionExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_preview_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_install_pings" (
    "siteId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "loaderVersion" TEXT,
    "configFetchOk" BOOLEAN,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "assist_site_install_pings_pkey" PRIMARY KEY ("siteId","origin")
);

-- CreateTable
CREATE TABLE "assist_site_wizards" (
    "siteId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "businessType" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "draftRuns" INTEGER NOT NULL DEFAULT 0,
    "spentMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_wizards_pkey" PRIMARY KEY ("siteId")
);

-- CreateTable
CREATE TABLE "assist_site_assets" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_widget_drafts" (
    "id" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "ipKey" TEXT NOT NULL,
    "appliedToSiteId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_widget_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_acquisitions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "campaign" TEXT,
    "landingPath" TEXT,
    "utm" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_acquisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_landing_events" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "props" JSONB,
    "locale" TEXT,
    "variant" TEXT,
    "path" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_landing_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assist_site_config_versions_accountId_idx" ON "assist_site_config_versions"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_config_versions_siteId_kind_version_key" ON "assist_site_config_versions"("siteId", "kind", "version");

-- CreateIndex
CREATE INDEX "assist_site_visitor_resumes_siteId_visitorId_idx" ON "assist_site_visitor_resumes"("siteId", "visitorId");

-- CreateIndex
CREATE INDEX "assist_site_visitor_resumes_expiresAt_idx" ON "assist_site_visitor_resumes"("expiresAt");

-- CreateIndex
CREATE INDEX "assist_site_conversations_siteId_visitorId_lastMessageAt_idx" ON "assist_site_conversations"("siteId", "visitorId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "assist_site_conversations_siteId_createdAt_idx" ON "assist_site_conversations"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_conversations_lastMessageAt_idx" ON "assist_site_conversations"("lastMessageAt");

-- CreateIndex
CREATE INDEX "assist_site_conversations_accountId_idx" ON "assist_site_conversations"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_conversations_id_accountId_key" ON "assist_site_conversations"("id", "accountId");

-- CreateIndex
CREATE INDEX "assist_site_messages_conversationId_createdAt_idx" ON "assist_site_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_messages_siteId_createdAt_idx" ON "assist_site_messages"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_messages_accountId_idx" ON "assist_site_messages"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_messages_conversationId_clientRequestId_key" ON "assist_site_messages"("conversationId", "clientRequestId");

-- CreateIndex
CREATE INDEX "assist_site_leads_siteId_createdAt_idx" ON "assist_site_leads"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_leads_deliveryState_lockedUntil_idx" ON "assist_site_leads"("deliveryState", "lockedUntil");

-- CreateIndex
CREATE INDEX "assist_site_leads_conversationId_idx" ON "assist_site_leads"("conversationId");

-- CreateIndex
CREATE INDEX "assist_site_leads_accountId_idx" ON "assist_site_leads"("accountId");

-- CreateIndex
CREATE INDEX "assist_budget_days_day_idx" ON "assist_budget_days"("day");

-- CreateIndex
CREATE INDEX "assist_budget_reservations_expiresAt_idx" ON "assist_budget_reservations"("expiresAt");

-- CreateIndex
CREATE INDEX "assist_budget_reservations_siteId_day_idx" ON "assist_budget_reservations"("siteId", "day");

-- CreateIndex
CREATE INDEX "assist_site_semantic_cache_expiresAt_idx" ON "assist_site_semantic_cache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_semantic_cache_siteId_key_key" ON "assist_site_semantic_cache"("siteId", "key");

-- CreateIndex
CREATE INDEX "assist_rate_buckets_expiresAt_idx" ON "assist_rate_buckets"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_preview_tokens_tokenHash_key" ON "assist_site_preview_tokens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_preview_tokens_sessionHash_key" ON "assist_site_preview_tokens"("sessionHash");

-- CreateIndex
CREATE INDEX "assist_site_preview_tokens_siteId_idx" ON "assist_site_preview_tokens"("siteId");

-- CreateIndex
CREATE INDEX "assist_site_preview_tokens_expiresAt_idx" ON "assist_site_preview_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "assist_site_preview_tokens_accountId_idx" ON "assist_site_preview_tokens"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_wizards_accountId_idx" ON "assist_site_wizards"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_wizards_siteId_accountId_key" ON "assist_site_wizards"("siteId", "accountId");

-- CreateIndex
CREATE INDEX "assist_site_assets_siteId_idx" ON "assist_site_assets"("siteId");

-- CreateIndex
CREATE INDEX "assist_site_assets_accountId_idx" ON "assist_site_assets"("accountId");

-- CreateIndex
CREATE INDEX "assist_widget_drafts_expiresAt_idx" ON "assist_widget_drafts"("expiresAt");

-- CreateIndex
CREATE INDEX "assist_acquisitions_accountId_idx" ON "assist_acquisitions"("accountId");

-- CreateIndex
CREATE INDEX "assist_landing_events_name_createdAt_idx" ON "assist_landing_events"("name", "createdAt");

-- CreateIndex
CREATE INDEX "assist_landing_events_createdAt_idx" ON "assist_landing_events"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "assist_sites_publicKey_key" ON "assist_sites"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "assist_sites_testKey_key" ON "assist_sites"("testKey");

-- AddForeignKey
ALTER TABLE "assist_site_config_versions" ADD CONSTRAINT "assist_site_config_versions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_visitor_resumes" ADD CONSTRAINT "assist_site_visitor_resumes_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_conversations" ADD CONSTRAINT "assist_site_conversations_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_messages" ADD CONSTRAINT "assist_site_messages_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_messages" ADD CONSTRAINT "assist_site_messages_conversationId_accountId_fkey" FOREIGN KEY ("conversationId", "accountId") REFERENCES "assist_site_conversations"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_leads" ADD CONSTRAINT "assist_site_leads_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_leads" ADD CONSTRAINT "assist_site_leads_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "assist_site_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_period_usage" ADD CONSTRAINT "assist_site_period_usage_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_semantic_cache" ADD CONSTRAINT "assist_site_semantic_cache_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_preview_tokens" ADD CONSTRAINT "assist_site_preview_tokens_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_install_pings" ADD CONSTRAINT "assist_site_install_pings_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_wizards" ADD CONSTRAINT "assist_site_wizards_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_assets" ADD CONSTRAINT "assist_site_assets_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_acquisitions" ADD CONSTRAINT "assist_acquisitions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "site_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ══ Роль assist_public (ТЗ §4.3-бис слой 3, §4.17, §4-бис.9) ═════════════
-- Правило Э0: REVOKE по умолчанию, явный список. Новые таблицы выше без
-- строки здесь роли НЕДОСТУПНЫ. Белый список целиком сверяет
-- src/prisma/assist-public-role.spec.ts (таблицы — из базы).
-- Колоночные GRANT там, где публичному маршруту нужна часть строки.
-- Помним: Prisma `create`/`update` возвращают строку (RETURNING) — на
-- возвращаемые колонки нужен SELECT; поэтому публичный клиент не выбирает
-- закрытые колонки вовсе (глобальный `omit` в AssistPublicDb) или пишет
-- через createMany (без RETURNING).

-- assist_sites: таблица Э1 читалась целиком. Теперь в ней черновики
-- вида/персоны (кабинет) — роли нужны только опубликованные номера версий,
-- ключи, рубильники, потолок, соль, сводка, сроки и форма лида (поля и
-- текст согласия посетитель и так видит в виджете — не секрет).
REVOKE SELECT ON "assist_sites" FROM assist_public;
GRANT SELECT ("id", "accountId", "siteId", "enabled", "knowledgeVersion", "configVersion", "suggestedQuestions", "suggestedForVersion", "publicKey", "testKey", "widgetVersion", "chatPaused", "operatorBlockedAt", "allowClientPreview", "dailyCapMicroUsd", "ipSalt", "siteSummary", "siteSummaryVersion", "retentionDays", "leadsConfig") ON "assist_sites" TO assist_public;

-- site_hosts: гвард origin зовёт evaluateHostAccess — ему нужна блокировка
-- повторного подтверждения (QA §5.1), без неё льгота 72 ч выдавалась бы
-- выдворенному кабинету.
GRANT SELECT ("reverifyBlockedAt") ON "site_hosts" TO assist_public;

-- assist_site_faq (сужение из Э1): прямой ответ проверенным ответом
-- (§4.5 п.1, §4-тер.10) — вопрос, ответ, варианты, язык, статус, источник.
-- Кто подтвердил/создал (telegramId), заметки о конфликте и связь с
-- диалогом — кабинету, не виджету.
REVOKE SELECT ON "assist_site_faq" FROM assist_public;
GRANT SELECT ("id", "accountId", "siteId", "question", "answer", "variants", "lang", "origin", "sourceRefs", "status", "documentId", "updatedAt") ON "assist_site_faq" TO assist_public;

-- assist_sandboxes (сужение из Э1): строки кабинетных песочниц лежат в той
-- же таблице — telegramId создателя роли не нужен ни для чего; кабинет,
-- сайт, перенос и скриншот меняет только кабинет/воркер. Публичный клиент
-- (AssistPublicDb) не выбирает createdByTelegramId глобальным `omit`.
REVOKE SELECT, INSERT, UPDATE ON "assist_sandboxes" FROM assist_public;
GRANT SELECT ("id", "kind", "accountId", "siteId", "browserKeyHash", "url", "host", "registrableDomain", "ipKey", "status", "statusReason", "progress", "title", "lang", "themeColor", "pagesLimit", "pagesRead", "questionsLimit", "questions", "costMicroUsd", "suggestedQuestions", "screenshotKey", "reusedFromId", "transferredAt", "lockedUntil", "attempts", "expiresAt", "createdAt", "updatedAt") ON "assist_sandboxes" TO assist_public;
GRANT INSERT ("id", "kind", "browserKeyHash", "url", "host", "registrableDomain", "ipKey", "status", "statusReason", "progress", "title", "lang", "themeColor", "pagesLimit", "pagesRead", "questionsLimit", "questions", "costMicroUsd", "suggestedQuestions", "reusedFromId", "lockedUntil", "attempts", "expiresAt", "createdAt", "updatedAt") ON "assist_sandboxes" TO assist_public;
GRANT UPDATE ("status", "statusReason", "progress", "title", "lang", "themeColor", "pagesRead", "questions", "costMicroUsd", "suggestedQuestions", "reusedFromId", "lockedUntil", "attempts", "updatedAt") ON "assist_sandboxes" TO assist_public;

-- Опубликованные вид и персона: конфиг виджета и блок <persona> промпта.
GRANT SELECT ("siteId", "kind", "version", "config") ON "assist_site_config_versions" TO assist_public;

-- Указатель посетителя: выдача, восстановление, продление, forget.
GRANT SELECT, INSERT, UPDATE, DELETE ON "assist_site_visitor_resumes" TO assist_public;

-- Диалоги: создание, состояние, счётчики; forget удаляет (сообщения —
-- каскадом FK, лиды — SET NULL; ссылочные действия идут от владельца таблицы).
GRANT SELECT, INSERT, UPDATE, DELETE ON "assist_site_conversations" TO assist_public;
GRANT SELECT, INSERT, UPDATE ON "assist_site_messages" TO assist_public;

-- Лид: только запись (createMany, без RETURNING). Читает и доставляет в
-- бот — системный код под основной ролью (участники кабинета роли не видны).
GRANT INSERT ON "assist_site_leads" TO assist_public;

-- Деньги и лимиты (§4.5): условные UPDATE строк дня, резервы с TTL,
-- счётчик диалогов периода, окна частоты.
GRANT SELECT, INSERT, UPDATE ON "assist_budget_days" TO assist_public;
GRANT SELECT, INSERT, DELETE ON "assist_budget_reservations" TO assist_public;
GRANT SELECT, INSERT, UPDATE ON "assist_site_period_usage" TO assist_public;
GRANT SELECT, INSERT, UPDATE ON "assist_rate_buckets" TO assist_public;

-- Семантический кэш: чтение, запись, счётчик попаданий, удаление по 👎.
GRANT SELECT, INSERT, UPDATE, DELETE ON "assist_site_semantic_cache" TO assist_public;

-- Предпросмотр: обмен одноразового токена на сессию (одним условным UPDATE).
-- Кто выдал (telegramId) — не нужен.
GRANT SELECT ("id", "accountId", "siteId", "tokenHash", "purpose", "origin", "draft", "expiresAt", "usedAt", "sessionHash", "sessionExpiresAt") ON "assist_site_preview_tokens" TO assist_public;
GRANT UPDATE ("usedAt", "sessionHash", "sessionExpiresAt") ON "assist_site_preview_tokens" TO assist_public;

-- Логотип/аватар: отдача байтов картинки по id (GET /widget/v1/asset/:id).
GRANT SELECT ("id", "siteId", "kind", "mime", "sha256", "bytes", "width", "height") ON "assist_site_assets" TO assist_public;

-- Пинг загрузчика (проверка установки): upsert по (siteId, origin).
GRANT SELECT, INSERT, UPDATE ON "assist_site_install_pings" TO assist_public;

-- Лендинг: анонимный черновик вида («к Л3») и события — только запись.
GRANT INSERT ON "assist_widget_drafts" TO assist_public;
GRANT INSERT ON "assist_landing_events" TO assist_public;

-- НЕ выдаём: assist_site_wizards (кабинет), assist_acquisitions (пишет
-- кабинет при первом входе), assist_admin_* (никогда, К-9).
