-- Заход 10, пакет Г — «Админка» (doc/TODO.md: №57, Ш6 (4), Ш6 (7), push
-- тревоги компенсаций):
--  * №57 (ТЗ §5-тер.13, Р-48): аналитика «Админки» — свои таблицы
--    assist_admin_conversation_labels / _daily_stats / _insights / _exports;
--    «Сайт» их не называет (правило графа), роль assist_public прав на них
--    не получает (как на все assist_admin_*);
--  * Р-З10-16 (Ш6 (7)): флаг сайта «админка — Telegram Mini App»
--    (adminTmaFrame) вместо env ASSIST_ADMIN_TMA_SITE_IDS (env — OR до удаления);
--  * Р-З10-15 (Ш6 (4)): подпись кнопки помощника (widgetLabel → data-label);
--  * Р-З10-13: дедуп push тревоги компенсаций сайт × сутки (compensationAlertDay);
--  * настройки аналитики: разметка вкл/выкл, минуты на тип задачи,
--    еженедельный отчёт и его дедуп сайт × неделя;
--  * аудит захода 10: индексы сканов крона (lastActivityAt диалогов,
--    createdAt предложений, labeledAt разметки, day свёртки) и явный REVOKE.
--
-- Пишется РУКАМИ; CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.

-- AlterTable
ALTER TABLE "assist_admin_settings" ADD COLUMN     "adminTmaFrame" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "analyticsLabeling" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "analyticsTaskMinutes" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "compensationAlertDay" TEXT,
ADD COLUMN     "weeklyReport" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "weeklyReportWeek" TEXT,
ADD COLUMN     "widgetLabel" TEXT;

-- CreateTable
CREATE TABLE "assist_admin_conversation_labels" (
    "conversationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "answerFound" TEXT NOT NULL,
    "toolError" BOOLEAN NOT NULL DEFAULT false,
    "quality" INTEGER,
    "status" TEXT NOT NULL,
    "employeeRole" TEXT,
    "conversationAt" TIMESTAMP(3) NOT NULL,
    "labeledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "assist_admin_conversation_labels_pkey" PRIMARY KEY ("conversationId")
);

-- CreateTable
CREATE TABLE "assist_admin_daily_stats" (
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "conversations" INTEGER NOT NULL DEFAULT 0,
    "questions" INTEGER NOT NULL DEFAULT 0,
    "refused" INTEGER NOT NULL DEFAULT 0,
    "thumbsDown" INTEGER NOT NULL DEFAULT 0,
    "labeled" INTEGER NOT NULL DEFAULT 0,
    "answerYes" INTEGER NOT NULL DEFAULT 0,
    "answerPartial" INTEGER NOT NULL DEFAULT 0,
    "toolErrors" INTEGER NOT NULL DEFAULT 0,
    "proposed" INTEGER NOT NULL DEFAULT 0,
    "confirmed" INTEGER NOT NULL DEFAULT 0,
    "actionsFailed" INTEGER NOT NULL DEFAULT 0,
    "minutesSaved" INTEGER NOT NULL DEFAULT 0,
    "taskTypes" JSONB NOT NULL DEFAULT '{}',
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_daily_stats_pkey" PRIMARY KEY ("siteId","day","role")
);

-- CreateTable
CREATE TABLE "assist_admin_insights" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "findings" JSONB NOT NULL,
    "text" JSONB,
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "doneAt" TIMESTAMP(3),
    "feedback" INTEGER,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_admin_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_exports" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "requestedByTelegramId" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "blobKey" TEXT,
    "rows" INTEGER,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_admin_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assist_admin_action_proposals_createdAt_idx" ON "assist_admin_action_proposals"("createdAt");

-- CreateIndex
CREATE INDEX "assist_admin_conversation_labels_labeledAt_idx" ON "assist_admin_conversation_labels"("labeledAt");

-- CreateIndex
CREATE INDEX "assist_admin_conversations_lastActivityAt_idx" ON "assist_admin_conversations"("lastActivityAt");

-- CreateIndex
CREATE INDEX "assist_admin_daily_stats_day_idx" ON "assist_admin_daily_stats"("day");

-- CreateIndex
CREATE INDEX "assist_admin_conversation_labels_siteId_conversationAt_idx" ON "assist_admin_conversation_labels"("siteId", "conversationAt");

-- CreateIndex
CREATE INDEX "assist_admin_conversation_labels_accountId_idx" ON "assist_admin_conversation_labels"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_conversation_labels_conversationId_accountId_key" ON "assist_admin_conversation_labels"("conversationId", "accountId");

-- CreateIndex
CREATE INDEX "assist_admin_daily_stats_accountId_idx" ON "assist_admin_daily_stats"("accountId");

-- CreateIndex
CREATE INDEX "assist_admin_insights_accountId_idx" ON "assist_admin_insights"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_admin_insights_siteId_weekStart_key" ON "assist_admin_insights"("siteId", "weekStart");

-- CreateIndex
CREATE INDEX "assist_admin_exports_status_createdAt_idx" ON "assist_admin_exports"("status", "createdAt");

-- CreateIndex
CREATE INDEX "assist_admin_exports_siteId_createdAt_idx" ON "assist_admin_exports"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_admin_exports_accountId_idx" ON "assist_admin_exports"("accountId");

-- AddForeignKey
ALTER TABLE "assist_admin_conversation_labels" ADD CONSTRAINT "assist_admin_conversation_labels_conversationId_accountId_fkey" FOREIGN KEY ("conversationId", "accountId") REFERENCES "assist_admin_conversations"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_daily_stats" ADD CONSTRAINT "assist_admin_daily_stats_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "assist_admin_settings"("siteId", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_insights" ADD CONSTRAINT "assist_admin_insights_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "assist_admin_settings"("siteId", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_exports" ADD CONSTRAINT "assist_admin_exports_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "assist_admin_settings"("siteId", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Аудит захода 10 (P3 (8)): роль виджета «Сайта» к аналитике «Админки» не
-- имеет никакого доступа — явно, независимо от прав схемы по умолчанию
-- (сверка — src/prisma/assist-public-role.spec.ts).
REVOKE ALL ON TABLE "assist_admin_conversation_labels" FROM assist_public;
REVOKE ALL ON TABLE "assist_admin_daily_stats" FROM assist_public;
REVOKE ALL ON TABLE "assist_admin_insights" FROM assist_public;
REVOKE ALL ON TABLE "assist_admin_exports" FROM assist_public;
