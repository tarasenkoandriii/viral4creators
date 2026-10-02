-- Э4 ИИ-помощника «Тарифы и оплата». ТЗ помощника §7.1, §3.10, §4.1, §6.1,
-- §8 (п.1–5, 8); план, Приложение А «Этап 4».
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma 7.10, дальше правки и
-- комментарии); CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.
--
-- Что здесь:
--  * assist_site_period_usage (Э2, квота по сайту) удалена — её место
--    занял счётчик единиц подписки;
--  * assist_subscriptions — тариф кабинета (подписка), способ продления,
--    шифр recToken WayForPay, автодокупка с потолком;
--  * assist_account_usage — единицы диалогов периода подписки (условный
--    UPDATE — атомарная квота; ×2 после 30 ответов, веса голоса/«Админки»);
--  * assist_payments — чекауты и факты оплаты Stars/WayForPay; уникальность
--    (method, providerRef) — идемпотентность колбэков;
--  * assist_legal_acceptances — принятые Условия и DPA с версией;
--  * assist_platform_* — настройки, журнал доступа и кандидаты eval для
--    вкладки «Помощник» админки платформы (внутренний API).
--  * GRANT роли assist_public — в конце, минимальные, с причиной.

-- Счётчик диалогов Э2 по САЙТУ (assist_site_period_usage, квота «как
-- Start до Э4») заменён счётчиком единиц ПОДПИСКИ (assist_account_usage):
-- лимит тарифа общий для сайтов кабинета (§7.1, Р-58). Строки Э2 — только
-- счётчики месяца, переносить нечего (новый период начнётся с нуля).
-- DropForeignKey
ALTER TABLE "assist_site_period_usage" DROP CONSTRAINT "assist_site_period_usage_siteId_fkey";

-- DropTable
DROP TABLE "assist_site_period_usage";

-- CreateTable
CREATE TABLE "assist_subscriptions" (
    "accountId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "method" TEXT NOT NULL,
    "anchorAt" TIMESTAMP(3) NOT NULL,
    "paidThrough" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "recTokenEnc" TEXT,
    "starsChargeId" TEXT,
    "starsPayerTelegramId" BIGINT,
    "autoTopUp" BOOLEAN NOT NULL DEFAULT false,
    "autoTopUpCapMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "renewClaimedAt" TIMESTAMP(3),
    "renewAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastRenewError" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_subscriptions_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "assist_account_usage" (
    "accountId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,
    "dialogs" INTEGER NOT NULL DEFAULT 0,
    "extraUnits" INTEGER NOT NULL DEFAULT 0,
    "autoPacks" INTEGER NOT NULL DEFAULT 0,
    "autoSpentMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "exhaustedAt" TIMESTAMP(3),
    "warned80At" TIMESTAMP(3),
    "warned100At" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_account_usage_pkey" PRIMARY KEY ("accountId","periodKey")
);

-- CreateTable
CREATE TABLE "assist_payments" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "planId" TEXT,
    "units" INTEGER,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "currency" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "amountMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "providerRef" TEXT,
    "parentId" TEXT,
    "periodKey" TEXT,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "createdByTelegramId" BIGINT,
    "payerTelegramId" BIGINT,
    "failureReason" TEXT,
    "rawPayload" JSONB,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_legal_acceptances" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "evalConsent" BOOLEAN NOT NULL DEFAULT false,
    "acceptedByTelegramId" BIGINT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_legal_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "assist_platform_access_log" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_platform_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_platform_eval_candidates" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_platform_eval_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assist_subscriptions_paidThrough_idx" ON "assist_subscriptions"("paidThrough");

-- CreateIndex
CREATE INDEX "assist_payments_accountId_createdAt_idx" ON "assist_payments"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_payments_status_createdAt_idx" ON "assist_payments"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "assist_payments_method_providerRef_key" ON "assist_payments"("method", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "assist_legal_acceptances_accountId_document_version_key" ON "assist_legal_acceptances"("accountId", "document", "version");

-- CreateIndex
CREATE INDEX "assist_platform_access_log_at_idx" ON "assist_platform_access_log"("at");

-- CreateIndex
CREATE UNIQUE INDEX "assist_platform_eval_candidates_messageId_key" ON "assist_platform_eval_candidates"("messageId");

-- AddForeignKey
ALTER TABLE "assist_subscriptions" ADD CONSTRAINT "assist_subscriptions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "site_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_account_usage" ADD CONSTRAINT "assist_account_usage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "site_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_legal_acceptances" ADD CONSTRAINT "assist_legal_acceptances_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "site_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ══ Роль assist_public (виджет) — минимум для квоты и рубильника ══

-- Тариф кабинета для лимита единиц и суточного потолка сайта. Без шифра
-- recToken, charge Stars, служебных полей продления и пометок оператора.
GRANT SELECT ("accountId", "planId", "status", "method", "anchorAt", "paidThrough", "cancelAtPeriodEnd", "autoTopUp", "autoTopUpCapMicroUsd") ON "assist_subscriptions" TO assist_public;
-- Счётчик единиц: создать строку периода (INSERT … ON CONFLICT DO NOTHING
-- без цели), занять единицы одним условным UPDATE, отметить мягкий стоп.
-- Докупку и автодокупку пишет только основная роль (оплата, крон).
GRANT SELECT ON "assist_account_usage" TO assist_public;
GRANT INSERT ("accountId", "periodKey", "updatedAt") ON "assist_account_usage" TO assist_public;
GRANT UPDATE ("units", "dialogs", "exhaustedAt", "updatedAt") ON "assist_account_usage" TO assist_public;
-- Начало пробного периода — первый сайт кабинета с помощником
-- (min(assist_sites.createdAt)), пока крон не записал строку подписки.
GRANT SELECT ("createdAt") ON "assist_sites" TO assist_public;
-- Рубильник и потолок платформы из админки (§8 п.5) — только значение.
GRANT SELECT ("key", "value") ON "assist_platform_settings" TO assist_public;
