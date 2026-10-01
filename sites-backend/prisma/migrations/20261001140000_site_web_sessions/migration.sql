-- Э0-W: сессии веб-кабинета (вход виджетом Telegram в обычном браузере).
--
-- Пишется РУКАМИ; CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем: они уже могли накатиться на стенд.

-- CreateTable
CREATE TABLE "site_web_sessions" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "app" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ipHash" TEXT,

    CONSTRAINT "site_web_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_web_sessions_tokenHash_key" ON "site_web_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "site_web_sessions_telegramId_idx" ON "site_web_sessions"("telegramId");

-- CreateIndex
CREATE INDEX "site_web_sessions_expiresAt_idx" ON "site_web_sessions"("expiresAt");

-- Роль assist_public: прав НЕ выдаём — виджету сессии кабинета не нужны.
