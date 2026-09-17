-- Этап 111 — черновик обучалки по сайту заказчика и счётчик раундов
-- (doc/CLIENT-SITE-TUTORIAL-SPEC.md §6.1 и §9).
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md), `prisma migrate diff --exit-code` в CI
-- проверит, что она не разошлась со schema.prisma.

-- Статус черновика. REJECTED не тупик: `rejectionReason` заполняется
-- оператором, а POST .../resume возвращает черновик в DRAFTING (§14 п.10).
CREATE TYPE "ClientSiteTutorialDraftStatus" AS ENUM ('DRAFTING', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- Один незавершённый черновик на проект обеспечивается UNIQUE на
-- "projectId" (§9: «лимит на число активных черновиков на пользователя —
-- 1 незавершённый на проект уже обеспечен @unique»).
CREATE TABLE "client_site_tutorial_drafts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "lastUrl" TEXT,
    "cookiesEnc" TEXT,
    "credentialsEnc" TEXT,
    "requiresLiveLoginReplay" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    -- Первый INTEGER[] в схеме проекта (остальные массивы — TEXT[]):
    -- длина этого массива равна числу РАУНДОВ, а его значения — числу
    -- ScenarioStep, дописанных каждым раундом (§15 п.3).
    "stepsPerRound" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "roundScreenshots" JSONB NOT NULL,
    "status" "ClientSiteTutorialDraftStatus" NOT NULL DEFAULT 'DRAFTING',
    "title" TEXT,
    "rejectionReason" TEXT,
    "previewFrameCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_site_tutorial_drafts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_site_tutorial_drafts_projectId_key" ON "client_site_tutorial_drafts"("projectId");

CREATE INDEX "client_site_tutorial_drafts_status_idx" ON "client_site_tutorial_drafts"("status");

ALTER TABLE "client_site_tutorial_drafts" ADD CONSTRAINT "client_site_tutorial_drafts_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Дневной счётчик по пользователю. §9 ТЗ прямо требует ОТДЕЛЬНУЮ метрику
-- («здесь нет вызова ИИ», значит AiUsage/ai-pricing не подходят по
-- смыслу). Форма и ключ userId+day скопированы с "serp_api_usage" —
-- атомарное резервирование идёт тем же INSERT ... ON CONFLICT DO UPDATE
-- ... WHERE, а не read-then-write.
CREATE TABLE "client_site_tutorial_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "liveSessions" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_site_tutorial_usage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_site_tutorial_usage_userId_day_key" ON "client_site_tutorial_usage"("userId", "day");

ALTER TABLE "client_site_tutorial_usage" ADD CONSTRAINT "client_site_tutorial_usage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
