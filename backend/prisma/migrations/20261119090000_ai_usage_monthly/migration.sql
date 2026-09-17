-- Этап 118 — свёртка журнала расходов (doc/TODO.md §I-Б.5, часть
-- находки Б-1.7 второго аудита).
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md), `prisma migrate diff --exit-code` в CI
-- проверит, что она не разошлась со schema.prisma.
--
-- Уникального индекса по ключу свёртки нет намеренно: "userId"
-- nullable, а Postgres считает NULL-ы различными — повторный прогон
-- плодил бы дубли вместо конфликта. Идемпотентность даёт крон: он
-- сносит свёртку месяца и пишет её заново одной транзакцией.
CREATE TABLE "ai_usage_monthly" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "userId" TEXT,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "unpriced" BOOLEAN NOT NULL DEFAULT false,
    "calls" INTEGER NOT NULL DEFAULT 0,
    -- BIGINT, а не INTEGER: сумма за месяц по одной модели легко
    -- переваливает за 2 147 долларов (потолок INT в микродолларах), и
    -- переполнение было бы молчаливым и необратимым — сырых строк,
    -- по которым можно пересчитать, после свёртки не остаётся.
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_monthly_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_usage_monthly_month_idx" ON "ai_usage_monthly"("month");
CREATE INDEX "ai_usage_monthly_userId_idx" ON "ai_usage_monthly"("userId");

-- Та же судьба при удалении аккаунта, что и у сырой строки
-- (`ai_usage_userId_fkey`): идентификатор обнуляется, деньги остаются.
-- Без этого удалённый человек висел бы в топе расходов вечно, а его
-- идентификатор пережил бы удаление аккаунта.
ALTER TABLE "ai_usage_monthly" ADD CONSTRAINT "ai_usage_monthly_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
