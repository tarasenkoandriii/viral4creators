-- Э-С, шаг Ш1 (docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md §3.2,
-- вариант A; предложение П-С3 docs-tz/SECURITY-PROPOSALS-2026-10-02.md):
-- внутренний API sites-backend для обучалки генератора.
--
-- Пишется РУКАМИ; CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.
--
-- site_internal_requests — использованные id подписанных запросов
-- (HMAC с меткой времени и id, окно ±5 мин): повтор того же запроса внутри
-- окна отклоняется по первичному ключу. Глобальная таблица (вызывающий —
-- сервис, не кабинет), живёт сутки. Роли assist_public прав НЕ выдаётся:
-- публичному виджету до неё дела нет.

-- CreateTable
CREATE TABLE "site_internal_requests" (
    "requestId" TEXT NOT NULL,
    "caller" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_internal_requests_pkey" PRIMARY KEY ("requestId")
);

-- CreateIndex
CREATE INDEX "site_internal_requests_createdAt_idx" ON "site_internal_requests"("createdAt");
