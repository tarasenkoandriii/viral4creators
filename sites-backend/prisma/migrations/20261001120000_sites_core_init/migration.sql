-- Первая миграция схемы `sites` (Э0 ИИ-помощника, общее ядро site-core с QA).
--
-- Пишется РУКАМИ (doc/TELEGRAM-ADMIN.md §5), CI сверяет её со
-- schema.prisma через `prisma migrate diff --exit-code`. Таблицы создаются
-- без схемы в имени: migrate выставляет search_path по `?schema=sites` из
-- SITES_DIRECT_URL, так что всё ниже ложится в `sites`, а не в `public`
-- генератора. Исключение — тип `vector`: он живёт в схеме `extensions`
-- (так у Supabase) и потому назван полностью.

-- ── pgvector ────────────────────────────────────────────────────────────
-- Supabase уже держит схему `extensions`; в CI её создаёт шаг перед
-- миграциями, а IF NOT EXISTS делает строку безвредной в обоих местах.
CREATE SCHEMA IF NOT EXISTS "extensions";
CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "extensions";

-- ── Ядро site-core ──────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "site_accounts" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'owner',
    "region" TEXT NOT NULL DEFAULT 'other',
    "verifyToken" TEXT NOT NULL,
    "verifyTokenRotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_account_members" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "role" TEXT NOT NULL,
    "productRoles" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_account_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_sites" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "endClientId" TEXT,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_hosts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "scheme" TEXT NOT NULL DEFAULT 'https',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 443,
    "publicPlatform" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "method" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lastRecheckAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_hosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_ownership_challenges" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "checkedAt" TIMESTAMP(3),
    "lastRecheckAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_ownership_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_opt_out_domains" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_opt_out_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Без внешних ключей: расход переживает удаление кабинета/сайта.
CREATE TABLE "site_ai_usage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "siteId" TEXT,
    "product" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 1,
    "characters" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "pricingVersion" TEXT NOT NULL,
    "unpriced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_ai_usage_pkey" PRIMARY KEY ("id")
);

-- ── Помощник: фрагменты знаний «Сайт» и «Админка» (минимум Э0) ──────────

-- CreateTable
CREATE TABLE "assist_site_chunks" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" "extensions"."vector"(768),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_admin_chunks" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" "extensions"."vector"(768),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_admin_chunks_pkey" PRIMARY KEY ("id")
);

-- ── Индексы ─────────────────────────────────────────────────────────────

-- CreateIndex
CREATE UNIQUE INDEX "site_accounts_verifyToken_key" ON "site_accounts"("verifyToken");

-- CreateIndex
CREATE INDEX "site_account_members_telegramId_idx" ON "site_account_members"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "site_account_members_accountId_telegramId_key" ON "site_account_members"("accountId", "telegramId");

-- CreateIndex
CREATE INDEX "site_sites_accountId_idx" ON "site_sites"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "site_sites_id_accountId_key" ON "site_sites"("id", "accountId");

-- CreateIndex
CREATE INDEX "site_hosts_host_idx" ON "site_hosts"("host");

-- CreateIndex
CREATE INDEX "site_hosts_siteId_idx" ON "site_hosts"("siteId");

-- CreateIndex
-- Дубль хоста в кабинете — ошибка (QA §2.2); разные кабинеты — можно.
CREATE UNIQUE INDEX "site_hosts_accountId_scheme_host_port_key" ON "site_hosts"("accountId", "scheme", "host", "port");

-- CreateIndex
CREATE UNIQUE INDEX "site_hosts_id_accountId_key" ON "site_hosts"("id", "accountId");

-- CreateIndex
CREATE INDEX "site_ownership_challenges_hostId_idx" ON "site_ownership_challenges"("hostId");

-- CreateIndex
CREATE INDEX "site_ownership_challenges_accountId_idx" ON "site_ownership_challenges"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "site_opt_out_domains_domain_key" ON "site_opt_out_domains"("domain");

-- CreateIndex
CREATE INDEX "site_ai_usage_accountId_createdAt_idx" ON "site_ai_usage"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "site_ai_usage_siteId_createdAt_idx" ON "site_ai_usage"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "site_ai_usage_createdAt_idx" ON "site_ai_usage"("createdAt");

-- CreateIndex
CREATE INDEX "assist_site_chunks_siteId_idx" ON "assist_site_chunks"("siteId");

-- CreateIndex
CREATE INDEX "assist_admin_chunks_siteId_idx" ON "assist_admin_chunks"("siteId");

-- ── Внешние ключи ───────────────────────────────────────────────────────

-- AddForeignKey
ALTER TABLE "site_account_members" ADD CONSTRAINT "site_account_members_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "site_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_sites" ADD CONSTRAINT "site_sites_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "site_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_hosts" ADD CONSTRAINT "site_hosts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "site_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Составной ключ: хост и его сайт обязаны принадлежать одному кабинету —
-- изоляция тенантов держится и на уровне базы, не только в коде.
ALTER TABLE "site_hosts" ADD CONSTRAINT "site_hosts_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_ownership_challenges" ADD CONSTRAINT "site_ownership_challenges_hostId_accountId_fkey" FOREIGN KEY ("hostId", "accountId") REFERENCES "site_hosts"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_chunks" ADD CONSTRAINT "assist_site_chunks_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_admin_chunks" ADD CONSTRAINT "assist_admin_chunks_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Роль assist_public (ТЗ помощника §4.3-бис, слой 3; §4.17) ───────────
--
-- Публичные маршруты виджета ходят в БД под этой ролью. Правило — «ничего
-- по умолчанию, явный список»: новая таблица без GRANT ниже этой роли
-- недоступна, и забытый GRANT — это отказ виджета, а не утечка.
--
-- NOLOGIN: войти ею нельзя. Логин-роль с паролем владелец создаёт РУКАМИ
-- (`CREATE ROLE … LOGIN PASSWORD … IN ROLE assist_public`, см.
-- doc/DEPLOYMENT.md, раздел sites-backend): пароль в репозиторий не попадает.
-- Роли в Postgres общие на кластер, поэтому создание — условное.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assist_public') THEN
    CREATE ROLE assist_public NOLOGIN;
  END IF;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA "sites" FROM assist_public;
GRANT USAGE ON SCHEMA "sites" TO assist_public;
-- Тип `vector` и его операторы — в схеме `extensions`.
GRANT USAGE ON SCHEMA "extensions" TO assist_public;

-- Виджет узнаёт сайт и статус хоста (льгота 72 ч считается из revokedAt/
-- expiresAt). Только статусные колонки: метод и даты перепроверки ему ни к
-- чему.
GRANT SELECT ON "site_sites" TO assist_public;
GRANT SELECT ("id", "accountId", "siteId", "scheme", "host", "port", "publicPlatform", "status", "verifiedAt", "expiresAt", "revokedAt") ON "site_hosts" TO assist_public;
-- Учёт расходов виджета.
GRANT INSERT ON "site_ai_usage" TO assist_public;
-- Знания режима «Сайт» — только чтение (индексирует кабинет, не виджет).
GRANT SELECT ON "assist_site_chunks" TO assist_public;
-- НИЧЕГО на: assist_admin_* (изоляция «Админки»), site_accounts,
-- site_account_members, site_ownership_challenges, site_opt_out_domains,
-- _prisma_migrations.
