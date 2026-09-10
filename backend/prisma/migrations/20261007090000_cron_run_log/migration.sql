-- Этап 69 (доп. ТЗ «Кроны в админке», аналогично Solar Shop). История
-- прогонов десяти крон-задач: и настоящих (Vercel Cron, CronController),
-- и ручных (оператор из админки, AdminCronController). Никакого FK на
-- users — jobKey и triggeredBy достаточно, а у настоящего крона Vercel
-- вообще нет пользователя, привязка сделала бы колонку опциональной без
-- пользы.

CREATE TYPE "CronRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

CREATE TABLE "cron_run_logs" (
    "id" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "debugMode" BOOLEAN NOT NULL DEFAULT false,
    "status" "CronRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "summary" TEXT,
    "debugLog" JSONB,
    "errorMessage" TEXT,

    CONSTRAINT "cron_run_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cron_run_logs_jobKey_startedAt_idx" ON "cron_run_logs"("jobKey", "startedAt");
