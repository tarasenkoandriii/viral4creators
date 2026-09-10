-- Счётчик поисков YouTube Data API по пользователю/суткам — ТЗ §6.4, этап 11
-- плана реализации. Написано вручную (см. doc/TELEGRAM-ADMIN.md §5) по
-- образцу serp_api_usage; schema.prisma провалидирована `prisma validate`,
-- SQL применён к локальному Postgres 16 вслед за предыдущими миграциями.

-- CreateTable
CREATE TABLE "youtube_search_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "youtube_search_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: одна строка на пользователя в сутки — и ключ upsert'а.
CREATE UNIQUE INDEX "youtube_search_usage_userId_day_key" ON "youtube_search_usage"("userId", "day");

-- AddForeignKey: счётчик без пользователя не нужен — Cascade.
ALTER TABLE "youtube_search_usage" ADD CONSTRAINT "youtube_search_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
