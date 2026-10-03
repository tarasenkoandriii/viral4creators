-- Э3-бис ИИ-помощника «Аналитика с ИИ»: (а) ИИ-разметка диалогов, lead score,
-- выводы недели; (в) согласие и эксперименты; (б) поведенческие факторы.
-- ТЗ помощника §5-тер.2–5, §5-тер.8–10, §5-тер.14–17; план «Э3-бис — сделано».
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma, дальше правки и
-- комментарии); CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.
--
-- Что здесь:
--  * assist_site_conversations / assist_site_goal_events: хеш ключа визита
--    (`visitHash`) — ТОЛЬКО связанный режим (посетитель дал согласие на
--    аналитику по баннеру сайта, §5-тер.9): цель на другой странице
--    связывается с диалогом в окне атрибуции, конверсия — с единицей
--    эксперимента. Без согласия колонка пуста.
--  * assist_site_conversation_labels — разметка закрытого диалога моделью и
--    lead score кодом; FK на диалог с каскадом (forget и ретенция удаляют
--    разметку вместе с диалогом, §5-тер.15).
--  * assist_analytics_spend — месячный расход бюджета аналитики сайта (доля
--    подписки, Р-50/Р-58); потолок платформы — строка assist_budget_days
--    scope='analytics' (суточная).
--  * assist_site_lead_calibrations — калибровка score (Platt, Pro).
--  * assist_site_insights — находки недели (код) и выводы модели (Р-45).
--  * assist_site_experiments / _units — эксперименты только на посетителях
--    с согласием (единица — хеш ключа визита с солью сайта).
--  * assist_site_page_views (сырые, 7 дней) / assist_site_daily_pages
--    (свёртка, 13 мес) — поведение страниц агрегатами (К-11).
--  * GRANT роли assist_public — в конце, по колонкам, с причиной у каждой.
--    Разметке, расходу, калибровке, выводам и свёртке поведения — НИЧЕГО.

-- AlterTable
ALTER TABLE "assist_site_conversations" ADD COLUMN     "visitHash" TEXT;

-- AlterTable
ALTER TABLE "assist_site_goal_events" ADD COLUMN     "visitHash" TEXT;

-- CreateTable
CREATE TABLE "assist_site_conversation_labels" (
    "conversationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "model" TEXT,
    "promptVersion" TEXT NOT NULL,
    "intent" TEXT,
    "intentNote" TEXT,
    "stage" TEXT,
    "buyingSignals" TEXT[],
    "llmLikelihood" INTEGER,
    "outcome" TEXT,
    "failureReason" TEXT,
    "failureNote" TEXT,
    "sentimentStart" INTEGER,
    "sentimentEnd" INTEGER,
    "frustration" BOOLEAN NOT NULL DEFAULT false,
    "answerQuality" INTEGER,
    "qualityFlags" TEXT[],
    "topics" TEXT[],
    "entities" TEXT[],
    "leadScore" INTEGER,
    "leadBucket" TEXT,
    "leadFeatures" JSONB,
    "leadProb" DOUBLE PRECISION,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "humanOverride" JSONB,
    "overriddenBy" TEXT,
    "overriddenAt" TIMESTAMP(3),
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "labeledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_conversation_labels_pkey" PRIMARY KEY ("conversationId")
);

-- CreateTable
CREATE TABLE "assist_analytics_spend" (
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "spentMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_analytics_spend_pkey" PRIMARY KEY ("siteId","period")
);

-- CreateTable
CREATE TABLE "assist_site_lead_calibrations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "positives" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "auc" DOUBLE PRECISION,
    "brier" DOUBLE PRECISION,
    "ece" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_lead_calibrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_insights" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "findingKey" TEXT NOT NULL,
    "finding" JSONB NOT NULL,
    "impact" TEXT NOT NULL,
    "text" JSONB,
    "textSkipped" TEXT,
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "doneAt" TIMESTAMP(3),
    "followUp" JSONB,
    "feedback" INTEGER,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_experiments" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "goalKey" TEXT NOT NULL,
    "share" DOUBLE PRECISION NOT NULL,
    "salt" TEXT NOT NULL,
    "variant" JSONB,
    "status" TEXT NOT NULL,
    "horizonDays" INTEGER NOT NULL,
    "mdeRel" DOUBLE PRECISION NOT NULL,
    "minUnitsPerArm" INTEGER NOT NULL,
    "power" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "result" JSONB,
    "srmP" DOUBLE PRECISION,
    "startedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_experiment_units" (
    "experimentId" TEXT NOT NULL,
    "unitHash" TEXT NOT NULL,
    "arm" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "converted" BOOLEAN NOT NULL DEFAULT false,
    "convertedAt" TIMESTAMP(3),

    CONSTRAINT "assist_site_experiment_units_pkey" PRIMARY KEY ("experimentId","unitHash")
);

-- CreateTable
CREATE TABLE "assist_site_page_views" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "path" TEXT NOT NULL,
    "prevPath" TEXT,
    "source" TEXT NOT NULL,
    "refHost" TEXT,
    "utmCampaign" TEXT,
    "device" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "scrollMax" INTEGER NOT NULL DEFAULT 0,
    "activeMs" INTEGER NOT NULL DEFAULT 0,
    "totalMs" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "rageClicks" INTEGER NOT NULL DEFAULT 0,
    "jsErrors" INTEGER NOT NULL DEFAULT 0,
    "errorGroups" JSONB,
    "formStarted" BOOLEAN NOT NULL DEFAULT false,
    "formSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "formAbandonField" TEXT,
    "formInvalid" INTEGER NOT NULL DEFAULT 0,
    "backNav" BOOLEAN NOT NULL DEFAULT false,
    "lcpMs" INTEGER,
    "inpMs" INTEGER,
    "cls" DOUBLE PRECISION,
    "chatOpened" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_page_views_pkey" PRIMARY KEY ("siteId","id")
);

-- CreateTable
CREATE TABLE "assist_site_daily_pages" (
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "activeMsMedian" INTEGER NOT NULL DEFAULT 0,
    "scrollMedian" INTEGER NOT NULL DEFAULT 0,
    "deepScroll" INTEGER NOT NULL DEFAULT 0,
    "backNav" INTEGER NOT NULL DEFAULT 0,
    "rage" INTEGER NOT NULL DEFAULT 0,
    "jsErrors" INTEGER NOT NULL DEFAULT 0,
    "formStarts" INTEGER NOT NULL DEFAULT 0,
    "formAbandons" INTEGER NOT NULL DEFAULT 0,
    "abandonFields" JSONB NOT NULL DEFAULT '{}',
    "lcpP75" INTEGER,
    "inpP75" INTEGER,
    "clsP75" DOUBLE PRECISION,
    "chatOpens" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_daily_pages_pkey" PRIMARY KEY ("siteId","day","path")
);

-- CreateIndex
CREATE INDEX "assist_site_conversation_labels_siteId_labeledAt_idx" ON "assist_site_conversation_labels"("siteId", "labeledAt");

-- CreateIndex
CREATE INDEX "assist_site_conversation_labels_accountId_idx" ON "assist_site_conversation_labels"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_conversation_labels_conversationId_accountId_key" ON "assist_site_conversation_labels"("conversationId", "accountId");

-- CreateIndex
CREATE INDEX "assist_analytics_spend_accountId_period_idx" ON "assist_analytics_spend"("accountId", "period");

-- CreateIndex
CREATE INDEX "assist_site_lead_calibrations_accountId_idx" ON "assist_site_lead_calibrations"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_lead_calibrations_siteId_version_key" ON "assist_site_lead_calibrations"("siteId", "version");

-- CreateIndex
CREATE INDEX "assist_site_insights_siteId_weekStart_idx" ON "assist_site_insights"("siteId", "weekStart");

-- CreateIndex
CREATE INDEX "assist_site_insights_accountId_idx" ON "assist_site_insights"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_insights_siteId_weekStart_findingKey_key" ON "assist_site_insights"("siteId", "weekStart", "findingKey");

-- CreateIndex
CREATE INDEX "assist_site_experiments_siteId_status_idx" ON "assist_site_experiments"("siteId", "status");

-- CreateIndex
CREATE INDEX "assist_site_experiments_status_endsAt_idx" ON "assist_site_experiments"("status", "endsAt");

-- CreateIndex
CREATE INDEX "assist_site_experiments_accountId_idx" ON "assist_site_experiments"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_page_views_siteId_day_idx" ON "assist_site_page_views"("siteId", "day");

-- CreateIndex
CREATE INDEX "assist_site_page_views_day_idx" ON "assist_site_page_views"("day");

-- CreateIndex
CREATE INDEX "assist_site_daily_pages_accountId_idx" ON "assist_site_daily_pages"("accountId");

-- AddForeignKey
ALTER TABLE "assist_site_conversation_labels" ADD CONSTRAINT "assist_site_conversation_labels_conversationId_accountId_fkey" FOREIGN KEY ("conversationId", "accountId") REFERENCES "assist_site_conversations"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_conversation_labels" ADD CONSTRAINT "assist_site_conversation_labels_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_analytics_spend" ADD CONSTRAINT "assist_analytics_spend_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_lead_calibrations" ADD CONSTRAINT "assist_site_lead_calibrations_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_insights" ADD CONSTRAINT "assist_site_insights_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_experiments" ADD CONSTRAINT "assist_site_experiments_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_experiment_units" ADD CONSTRAINT "assist_site_experiment_units_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "assist_site_experiments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_page_views" ADD CONSTRAINT "assist_site_page_views_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_daily_pages" ADD CONSTRAINT "assist_site_daily_pages_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Права роли виджета assist_public (слой 3, §4.3-бис) ─────────────────

-- Связанный режим: iframe привязывает диалог к ключу визита посетителя,
-- давшего согласие (POST /widget/v1/visit) — только эту колонку.
GRANT UPDATE ("visitHash") ON "assist_site_conversations" TO assist_public;

-- Право посетителя на удаление (`/widget/v1/forget`, §5-тер.15): единицы
-- экспериментов посетителя (хеш его визита) удаляются. События целей роль
-- по-прежнему не читает: их хеш визита обнуляет ретенция (35 дней).
GRANT DELETE ON "assist_site_experiment_units" TO assist_public;

-- Конфиг загрузчика (идущий эксперимент: вид, доля, соль, вариант B) и
-- включение посетителя/конверсия — колонки без итога, расчёта мощности и
-- того, кто запустил.
GRANT SELECT ("id", "siteId", "kind", "goalKey", "share", "salt", "variant", "status", "startedAt", "endsAt") ON "assist_site_experiments" TO assist_public;

-- Единица эксперимента: вставка при включении (без цели конфликта — SELECT
-- на всю строку не нужен), отметка конверсии основной цели условным UPDATE.
GRANT SELECT ("experimentId", "unitHash", "converted", "enrolledAt") ON "assist_site_experiment_units" TO assist_public;
GRANT INSERT ("experimentId", "unitHash", "arm", "enrolledAt") ON "assist_site_experiment_units" TO assist_public;
GRANT UPDATE ("converted", "convertedAt") ON "assist_site_experiment_units" TO assist_public;

-- Итог просмотра (sendBeacon при скрытии вкладки; повтор перезаписывает
-- итог того же pvId): вставка, перезапись метрик, поиск строки по ключу
-- (и максимум прокрутки — новый итог не уменьшает уже записанную глубину).
GRANT SELECT ("id", "siteId", "scrollMax") ON "assist_site_page_views" TO assist_public;
GRANT INSERT ("id", "siteId", "day", "startedAt", "path", "prevPath", "source", "refHost", "utmCampaign", "device", "os", "browser", "scrollMax", "activeMs", "totalMs", "clicks", "rageClicks", "jsErrors", "errorGroups", "formStarted", "formSubmitted", "formAbandonField", "formInvalid", "backNav", "lcpMs", "inpMs", "cls", "chatOpened", "updatedAt") ON "assist_site_page_views" TO assist_public;
GRANT UPDATE ("scrollMax", "activeMs", "totalMs", "clicks", "rageClicks", "jsErrors", "errorGroups", "formStarted", "formSubmitted", "formAbandonField", "formInvalid", "backNav", "lcpMs", "inpMs", "cls", "chatOpened", "updatedAt") ON "assist_site_page_views" TO assist_public;
