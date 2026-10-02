-- Э3 ИИ-помощника «Передача человеку, сценарии, аналитика, обучение».
-- ТЗ помощника §3.2, §3.6 п.4–5, §3.7, §4-тер.3–4, §4-тер.12–15,
-- §5-тер.1–2, §5-тер.6–7, §5-тер.12, §5-тер.14–16, §9.1; контракт Э3
-- (/tmp/k/CONTRACT-E3.md).
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma 7.10, дальше правки и
-- комментарии); CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.
--
-- Что здесь:
--  * assist_sites: настройки передачи человеку (без секретов — их читает
--    виджет), медиана «~N минут», часовой пояс, валюта, настройки аналитики.
--  * Диалог/сообщения: кто начал диалог (openedBy), язык и перевод
--    сообщения, автор-оператор, «почему так ответил» (trace), отметка
--    «доставлено оператору».
--  * Передача человеку (assist_site_handoffs) — одна ОТКРЫТАЯ на диалог
--    (частичный уникальный индекс в конце — Prisma его не видит, diff
--    частичные индексы не читает, как HNSW Э1); сообщения бота для
--    реплаев/кнопок; люди, нажавшие Start у бота.
--  * Обучение: очередь (элементы + кластеры), хвост forget посетителя;
--    проверенный ответ и кейс eval получают ссылку на диалог с каскадом
--    (FK: forget/ретенция удаляют кейс из диалога, у ответа ссылка
--    обнуляется — §4-тер.12, §4-тер.15 п.12).
--  * Цели и статистика: цели, события целей (дедуп — уникальные ключи),
--    секреты интеграций (вебхук s2s, identify), суточная свёртка, счётчики
--    событий виджета, экспорт CSV, подписки на отчёты.
--  * GRANT роли assist_public — в конце, с причиной у каждой строки; плюс
--    СУЖЕНИЕ табличных UPDATE Э2 до колонок (ограничение «к Э3» плана).

-- AlterTable
ALTER TABLE "assist_site_conversations" ADD COLUMN     "openedBy" TEXT;

-- AlterTable
ALTER TABLE "assist_site_eval_cases" ADD COLUMN     "faqId" TEXT,
ADD COLUMN     "fromConversationId" TEXT;

-- AlterTable
ALTER TABLE "assist_site_faq" ADD COLUMN     "variantRefs" JSONB;

-- AlterTable
ALTER TABLE "assist_site_leads" ADD COLUMN     "identityEnc" TEXT,
ADD COLUMN     "identityVerified" BOOLEAN;

-- AlterTable
ALTER TABLE "assist_site_messages" ADD COLUMN     "authorMemberId" TEXT,
ADD COLUMN     "lang" TEXT,
ADD COLUMN     "relayedAt" TIMESTAMP(3),
ADD COLUMN     "trace" JSONB,
ADD COLUMN     "translation" JSONB;

-- AlterTable
ALTER TABLE "assist_site_preview_tokens" ADD COLUMN     "result" JSONB;

-- AlterTable
ALTER TABLE "assist_sites" ADD COLUMN     "analytics" JSONB,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'UAH',
ADD COLUMN     "handoffConfig" JSONB,
ADD COLUMN     "handoffEtaMinutes" INTEGER,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Europe/Kyiv';

-- CreateTable
CREATE TABLE "assist_site_handoffs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'waiting',
    "reason" TEXT NOT NULL,
    "escalation" TEXT,
    "visitorLang" TEXT,
    "operatorLang" TEXT,
    "pageUrl" TEXT,
    "summary" JSONB,
    "draft" JSONB,
    "identityEnc" TEXT,
    "identityVerified" BOOLEAN,
    "assignedMemberId" TEXT,
    "assignedTelegramId" BIGINT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "takenAt" TIMESTAMP(3),
    "firstReplyAt" TIMESTAMP(3),
    "lastOperatorAt" TIMESTAMP(3),
    "lastVisitorAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "reminders" INTEGER NOT NULL DEFAULT 0,
    "timeoutAt" TIMESTAMP(3) NOT NULL,
    "missedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "cards" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_bot_messages" (
    "chatId" BIGINT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "handoffId" TEXT,
    "conversationId" TEXT,
    "memberId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_bot_messages_pkey" PRIMARY KEY ("chatId","messageId")
);

-- CreateTable
CREATE TABLE "assist_bot_users" (
    "telegramId" BIGINT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "languageCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_bot_users_pkey" PRIMARY KEY ("telegramId")
);

-- CreateTable
CREATE TABLE "assist_site_learning_items" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "visitorId" TEXT,
    "suspicious" BOOLEAN NOT NULL DEFAULT false,
    "signal" TEXT,
    "questionMasked" TEXT NOT NULL,
    "answerMasked" TEXT,
    "lang" TEXT,
    "questionEmbedding" "extensions"."vector"(768),
    "clusterId" TEXT,
    "proposedAnswer" TEXT,
    "proposedByTelegramId" BIGINT,
    "proposedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'new',
    "resolution" TEXT,
    "faqId" TEXT,
    "resolvedByTelegramId" BIGINT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_learning_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_learning_clusters" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "distinctVisitors" INTEGER NOT NULL DEFAULT 0,
    "centroid" "extensions"."vector"(768),
    "lang" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "faqId" TEXT,
    "resolvedByTelegramId" BIGINT,
    "resolvedAt" TIMESTAMP(3),
    "reopenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_learning_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_forget_jobs" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "conversationIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "assist_site_forget_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_goals" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "detectors" JSONB NOT NULL,
    "valueMode" TEXT NOT NULL DEFAULT 'none',
    "fixedValue" DECIMAL(14,2),
    "currency" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastFiredAt" TIMESTAMP(3),
    "createdByTelegramId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_goal_events" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "trust" TEXT NOT NULL,
    "clientEventId" TEXT,
    "orderId" TEXT,
    "value" DECIMAL(14,2),
    "currency" TEXT,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "path" TEXT,
    "attribution" TEXT NOT NULL,
    "assist" JSONB,
    "conversationId" TEXT,

    CONSTRAINT "assist_site_goal_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_integrations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdByTelegramId" BIGINT,
    "rotatedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_daily_totals" (
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "group" TEXT NOT NULL DEFAULT 'all',
    "dialogs" INTEGER NOT NULL DEFAULT 0,
    "resolved" INTEGER NOT NULL DEFAULT 0,
    "answers" INTEGER NOT NULL DEFAULT 0,
    "unknown" INTEGER NOT NULL DEFAULT 0,
    "handoffs" INTEGER NOT NULL DEFAULT 0,
    "handoffsMissed" INTEGER NOT NULL DEFAULT 0,
    "leads" INTEGER NOT NULL DEFAULT 0,
    "thumbsUp" INTEGER NOT NULL DEFAULT 0,
    "thumbsDown" INTEGER NOT NULL DEFAULT 0,
    "widgetViews" INTEGER NOT NULL DEFAULT 0,
    "opens" INTEGER NOT NULL DEFAULT 0,
    "proactiveShown" INTEGER NOT NULL DEFAULT 0,
    "proactiveAccepted" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "conversions" JSONB NOT NULL DEFAULT '{}',
    "proactive" JSONB NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_daily_totals_pkey" PRIMARY KEY ("siteId","day","group")
);

-- CreateTable
CREATE TABLE "assist_site_event_counts" (
    "siteId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT '',
    "hour" INTEGER NOT NULL DEFAULT 0,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "assist_site_event_counts_pkey" PRIMARY KEY ("siteId","day","kind","key","hour")
);

-- CreateTable
CREATE TABLE "assist_site_exports" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "withText" BOOLEAN NOT NULL DEFAULT false,
    "requestedByTelegramId" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "blobKey" TEXT,
    "rows" INTEGER,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_report_subscriptions" (
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_report_subscriptions_pkey" PRIMARY KEY ("siteId","telegramId","kind")
);

-- CreateIndex
CREATE INDEX "assist_site_handoffs_siteId_state_idx" ON "assist_site_handoffs"("siteId", "state");

-- CreateIndex
CREATE INDEX "assist_site_handoffs_state_timeoutAt_idx" ON "assist_site_handoffs"("state", "timeoutAt");

-- CreateIndex
CREATE INDEX "assist_site_handoffs_conversationId_idx" ON "assist_site_handoffs"("conversationId");

-- CreateIndex
CREATE INDEX "assist_site_handoffs_accountId_idx" ON "assist_site_handoffs"("accountId");

-- CreateIndex
CREATE INDEX "assist_bot_messages_handoffId_idx" ON "assist_bot_messages"("handoffId");

-- CreateIndex
CREATE INDEX "assist_bot_messages_expiresAt_idx" ON "assist_bot_messages"("expiresAt");

-- CreateIndex
CREATE INDEX "assist_bot_messages_accountId_idx" ON "assist_bot_messages"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_learning_items_siteId_status_idx" ON "assist_site_learning_items"("siteId", "status");

-- CreateIndex
CREATE INDEX "assist_site_learning_items_siteId_createdAt_idx" ON "assist_site_learning_items"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_learning_items_clusterId_idx" ON "assist_site_learning_items"("clusterId");

-- CreateIndex
CREATE INDEX "assist_site_learning_items_conversationId_idx" ON "assist_site_learning_items"("conversationId");

-- CreateIndex
CREATE INDEX "assist_site_learning_items_accountId_idx" ON "assist_site_learning_items"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_learning_items_messageId_kind_key" ON "assist_site_learning_items"("messageId", "kind");

-- CreateIndex
CREATE INDEX "assist_site_learning_clusters_siteId_status_idx" ON "assist_site_learning_clusters"("siteId", "status");

-- CreateIndex
CREATE INDEX "assist_site_learning_clusters_accountId_idx" ON "assist_site_learning_clusters"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_forget_jobs_processedAt_idx" ON "assist_site_forget_jobs"("processedAt");

-- CreateIndex
CREATE INDEX "assist_site_forget_jobs_siteId_idx" ON "assist_site_forget_jobs"("siteId");

-- CreateIndex
CREATE INDEX "assist_site_goals_accountId_idx" ON "assist_site_goals"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_goals_siteId_key_key" ON "assist_site_goals"("siteId", "key");

-- CreateIndex
CREATE INDEX "assist_site_goal_events_siteId_occurredAt_idx" ON "assist_site_goal_events"("siteId", "occurredAt");

-- CreateIndex
CREATE INDEX "assist_site_goal_events_goalId_occurredAt_idx" ON "assist_site_goal_events"("goalId", "occurredAt");

-- CreateIndex
CREATE INDEX "assist_site_goal_events_conversationId_idx" ON "assist_site_goal_events"("conversationId");

-- CreateIndex
CREATE INDEX "assist_site_goal_events_accountId_idx" ON "assist_site_goal_events"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_goal_events_siteId_goalId_orderId_key" ON "assist_site_goal_events"("siteId", "goalId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_goal_events_siteId_clientEventId_key" ON "assist_site_goal_events"("siteId", "clientEventId");

-- CreateIndex
CREATE INDEX "assist_site_integrations_accountId_idx" ON "assist_site_integrations"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_integrations_siteId_kind_key" ON "assist_site_integrations"("siteId", "kind");

-- CreateIndex
CREATE INDEX "assist_site_daily_totals_accountId_idx" ON "assist_site_daily_totals"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_exports_status_lockedUntil_idx" ON "assist_site_exports"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "assist_site_exports_siteId_createdAt_idx" ON "assist_site_exports"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_exports_accountId_idx" ON "assist_site_exports"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_report_subscriptions_accountId_idx" ON "assist_site_report_subscriptions"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_eval_cases_fromConversationId_idx" ON "assist_site_eval_cases"("fromConversationId");

-- CreateIndex
CREATE INDEX "assist_site_faq_fromConversationId_idx" ON "assist_site_faq"("fromConversationId");

-- AddForeignKey
ALTER TABLE "assist_site_faq" ADD CONSTRAINT "assist_site_faq_fromConversationId_fkey" FOREIGN KEY ("fromConversationId") REFERENCES "assist_site_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_eval_cases" ADD CONSTRAINT "assist_site_eval_cases_fromConversationId_fkey" FOREIGN KEY ("fromConversationId") REFERENCES "assist_site_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_handoffs" ADD CONSTRAINT "assist_site_handoffs_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_handoffs" ADD CONSTRAINT "assist_site_handoffs_conversationId_accountId_fkey" FOREIGN KEY ("conversationId", "accountId") REFERENCES "assist_site_conversations"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_bot_messages" ADD CONSTRAINT "assist_bot_messages_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_learning_items" ADD CONSTRAINT "assist_site_learning_items_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_learning_items" ADD CONSTRAINT "assist_site_learning_items_conversationId_accountId_fkey" FOREIGN KEY ("conversationId", "accountId") REFERENCES "assist_site_conversations"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_learning_items" ADD CONSTRAINT "assist_site_learning_items_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "assist_site_learning_clusters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_learning_clusters" ADD CONSTRAINT "assist_site_learning_clusters_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_forget_jobs" ADD CONSTRAINT "assist_site_forget_jobs_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_goals" ADD CONSTRAINT "assist_site_goals_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_goal_events" ADD CONSTRAINT "assist_site_goal_events_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_goal_events" ADD CONSTRAINT "assist_site_goal_events_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "assist_site_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_goal_events" ADD CONSTRAINT "assist_site_goal_events_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "assist_site_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_integrations" ADD CONSTRAINT "assist_site_integrations_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_daily_totals" ADD CONSTRAINT "assist_site_daily_totals_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_event_counts" ADD CONSTRAINT "assist_site_event_counts_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_exports" ADD CONSTRAINT "assist_site_exports_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_report_subscriptions" ADD CONSTRAINT "assist_site_report_subscriptions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ══ Частичный уникальный индекс: одна открытая передача на диалог ═══════
-- Два параллельных «позвать человека» одного диалога: второй INSERT
-- получает 23505 (P2002) — его обрабатывает приём передачи (H) как «уже
-- ждём». Частичный — Prisma его не описывает и diff его не видит.
CREATE UNIQUE INDEX "assist_site_handoffs_open_conversation_key"
  ON "assist_site_handoffs" ("conversationId")
  WHERE "state" IN ('waiting', 'active');

-- ══ Роль assist_public (ТЗ §4.3-бис слой 3, §4-тер.14, §5-тер.14) ═══════
-- Правило Э0: REVOKE по умолчанию, явный список. Белый список целиком
-- сверяет src/prisma/assist-public-role.spec.ts; закрытые колонки
-- публичный клиент не выбирает (ASSIST_PUBLIC_OMIT).

-- assist_sites: передача (рабочие часы, ожидание, «~N минут») и пояс —
-- виджету нужны, чтобы решить «позвать человека» или сразу форма заявки;
-- настройки аналитики — приёму целей (CIDR офиса, исключённые пути).
-- Валюта отчётов виджету не нужна.
GRANT SELECT ("handoffConfig", "handoffEtaMinutes", "timezone", "analytics") ON "assist_sites" TO assist_public;

-- ── Сужение Э2: табличные UPDATE → колоночные (ограничение «к Э3») ──────
-- Колонки — ровно те, что пишет публичный код Э2 (+ Э3: состояние
-- передачи у диалога, язык и trace у сообщения). `updatedAt` — его
-- ставит Prisma (@updatedAt) при каждом update.
REVOKE UPDATE ON "assist_site_conversations" FROM assist_public;
GRANT UPDATE ("answers", "dialogCounted", "stateVersion", "lastMessageAt", "flagged", "outcome", "suspicious", "handoffState", "updatedAt") ON "assist_site_conversations" TO assist_public;

-- Сообщения: автор-оператор и перевод пишет только системный код передачи;
-- автор (id участника кабинета) роли не виден.
REVOKE SELECT, INSERT, UPDATE ON "assist_site_messages" FROM assist_public;
GRANT SELECT ("id", "accountId", "siteId", "conversationId", "role", "text", "sources", "actions", "flags", "clientRequestId", "streamState", "streamOffset", "answerPath", "cacheKey", "rating", "inTokens", "outTokens", "cachedTokens", "costMicroUsd", "model", "latencyMs", "lang", "translation", "trace", "relayedAt", "createdAt", "updatedAt") ON "assist_site_messages" TO assist_public;
GRANT INSERT ("id", "accountId", "siteId", "conversationId", "role", "text", "sources", "actions", "flags", "clientRequestId", "streamState", "streamOffset", "answerPath", "cacheKey", "rating", "inTokens", "outTokens", "cachedTokens", "costMicroUsd", "model", "latencyMs", "lang", "trace", "createdAt", "updatedAt") ON "assist_site_messages" TO assist_public;
GRANT UPDATE ("text", "streamOffset", "streamState", "sources", "actions", "flags", "answerPath", "cacheKey", "rating", "inTokens", "outTokens", "cachedTokens", "costMicroUsd", "model", "latencyMs", "lang", "trace", "updatedAt") ON "assist_site_messages" TO assist_public;

-- Деньги, квота, окна частоты, кэш, пинги, указатели: только счётчики и сроки.
REVOKE UPDATE ON "assist_budget_days" FROM assist_public;
GRANT UPDATE ("reservedMicroUsd", "spentMicroUsd", "updatedAt") ON "assist_budget_days" TO assist_public;
REVOKE UPDATE ON "assist_site_period_usage" FROM assist_public;
GRANT UPDATE ("dialogs", "updatedAt") ON "assist_site_period_usage" TO assist_public;
REVOKE UPDATE ON "assist_rate_buckets" FROM assist_public;
GRANT UPDATE ("count") ON "assist_rate_buckets" TO assist_public;
REVOKE UPDATE ON "assist_site_semantic_cache" FROM assist_public;
GRANT UPDATE ("answer", "expiresAt", "hits") ON "assist_site_semantic_cache" TO assist_public;
REVOKE UPDATE ON "assist_site_install_pings" FROM assist_public;
GRANT UPDATE ("allowed", "loaderVersion", "configFetchOk", "lastSeenAt", "count") ON "assist_site_install_pings" TO assist_public;
REVOKE UPDATE ON "assist_site_visitor_resumes" FROM assist_public;
GRANT UPDATE ("lastSeenAt", "expiresAt") ON "assist_site_visitor_resumes" TO assist_public;

-- Лид после forget (ограничение Э2 «к Э3»): посетитель отвязывает свой
-- visitorId от лидов (`UPDATE … SET visitorId = NULL WHERE siteId AND
-- visitorId` — WHERE требует SELECT этих двух колонок). Поля лида — нет.
-- identify — только вместе с лидом (К-3), шифром.
GRANT SELECT ("siteId", "visitorId") ON "assist_site_leads" TO assist_public;
GRANT UPDATE ("visitorId") ON "assist_site_leads" TO assist_public;
REVOKE INSERT ON "assist_site_leads" FROM assist_public;
-- Prisma `createMany` перечисляет ВСЕ скалярные колонки модели (значения
-- по умолчанию — явно), поэтому список — все колонки, кроме итога сверки
-- identify (его ставит только системная доставка).
GRANT INSERT ("id", "accountId", "siteId", "conversationId", "visitorId", "fieldsEnc", "fieldNames", "identityEnc", "consentText", "consentAt", "pageUrl", "deliveryState", "deliveredTo", "attempts", "lockedUntil", "lastError", "deliveredAt", "createdAt") ON "assist_site_leads" TO assist_public;

-- Выбор цели на сайте (purpose = goal): загрузчик пишет выбранный элемент.
GRANT UPDATE ("result") ON "assist_site_preview_tokens" TO assist_public;

-- ── Новые таблицы Э3 ─────────────────────────────────────────────────
-- Передача: посетитель создаёт (createMany, без RETURNING), видит статус
-- своей передачи и может её отменить/отметиться; кто взял, сводка,
-- черновик, карточки — системному коду.
GRANT SELECT ("id", "siteId", "conversationId", "state", "requestedAt", "takenAt", "timeoutAt", "missedAt", "closedAt") ON "assist_site_handoffs" TO assist_public;
-- (+ колонки с @default — Prisma `createMany` шлёт их явно.)
GRANT INSERT ("id", "accountId", "siteId", "conversationId", "state", "reason", "escalation", "visitorLang", "pageUrl", "identityEnc", "requestedAt", "timeoutAt", "reminders", "attempts", "costMicroUsd", "createdAt", "updatedAt") ON "assist_site_handoffs" TO assist_public;
GRANT UPDATE ("state", "lastVisitorAt", "closedAt", "closedBy", "updatedAt") ON "assist_site_handoffs" TO assist_public;

-- Очередь обучения: сигнал из чата/👎 — только запись (ON CONFLICT DO
-- NOTHING по (messageId, kind) — прав сверх INSERT не требует). Кандидат
-- оператора, решение, кластер — кабинету.
GRANT INSERT ("id", "accountId", "siteId", "kind", "conversationId", "messageId", "visitorId", "suspicious", "signal", "questionMasked", "answerMasked", "lang", "questionEmbedding", "status", "createdAt", "updatedAt") ON "assist_site_learning_items" TO assist_public;

-- Хвост forget посетителя — только запись.
GRANT INSERT ON "assist_site_forget_jobs" TO assist_public;

-- Цели: детекторы для загрузчика и приём события (дедуп — уникальные
-- ключи, ON CONFLICT DO NOTHING). Кто создал, имя для кабинета — нет.
GRANT SELECT ("id", "siteId", "key", "template", "detectors", "valueMode", "fixedValue", "currency", "status") ON "assist_site_goals" TO assist_public;
GRANT INSERT ON "assist_site_goal_events" TO assist_public;

-- Счётчики событий виджета: один UPSERT (count + n).
GRANT SELECT, INSERT ON "assist_site_event_counts" TO assist_public;
GRANT UPDATE ("count") ON "assist_site_event_counts" TO assist_public;

-- НЕ выдаём: assist_site_learning_clusters, assist_site_integrations
-- (секреты), assist_site_daily_totals, assist_site_exports,
-- assist_site_report_subscriptions, assist_bot_messages, assist_bot_users
-- (telegramId) — всё это кабинет и системный код; assist_admin_* — никогда (К-9).
