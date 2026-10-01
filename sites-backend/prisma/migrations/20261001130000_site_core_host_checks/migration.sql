-- site-core Э0 (агент B): итог последней проверки хоста, блокировка
-- повторного подтверждения отозванным кабинетом (QA-ТЗ §5.1) и приглашения
-- участников (ТЗ помощника §3.2, §4.16).
--
-- Пишется РУКАМИ; CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Первую миграцию не трогаем: она уже могла накатиться на стенд.

-- AlterTable
ALTER TABLE "site_hosts" ADD COLUMN "lastCheck" JSONB,
ADD COLUMN "reverifyBlockedAt" TIMESTAMP(3),
ADD COLUMN "reverifyBlockedByAccountId" TEXT;

-- CreateTable
CREATE TABLE "site_account_invites" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "productRoles" JSONB NOT NULL,
    "createdByTelegramId" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByTelegramId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_account_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_account_invites_tokenHash_key" ON "site_account_invites"("tokenHash");

-- CreateIndex
CREATE INDEX "site_account_invites_accountId_idx" ON "site_account_invites"("accountId");

-- CreateIndex
CREATE INDEX "site_hosts_status_lastRecheckAt_idx" ON "site_hosts"("status", "lastRecheckAt");

-- AddForeignKey
ALTER TABLE "site_account_invites" ADD CONSTRAINT "site_account_invites_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "site_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Роль assist_public: новых прав НЕ выдаём. Колоночный GRANT на site_hosts
-- из первой миграции новые колонки не покрывает, site_account_invites
-- виджету не нужна вовсе.
