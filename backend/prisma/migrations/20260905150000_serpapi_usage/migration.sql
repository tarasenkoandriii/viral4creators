-- Счётчик платных вызовов SerpApi по пользователю/суткам — ТЗ §7.5, этап 4
-- плана реализации. Написано вручную (см. doc/TELEGRAM-ADMIN.md §5),
-- schema.prisma провалидирована `prisma validate`, SQL применён к
-- локальному Postgres 16 вслед за предыдущими шестью миграциями.

-- CreateTable
CREATE TABLE "serp_api_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "serp_api_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: одна строка на пользователя в сутки — и ключ upsert'а.
CREATE UNIQUE INDEX "serp_api_usage_userId_day_key" ON "serp_api_usage"("userId", "day");

-- AddForeignKey: счётчик без пользователя не нужен — Cascade.
ALTER TABLE "serp_api_usage" ADD CONSTRAINT "serp_api_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
