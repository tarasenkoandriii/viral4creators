-- Пятый аудит (Д-3.3). Джоб-уровневый замок поверх поштучного claim
-- строк воркеров catalog-batch-run/ab-test-run/feed-import-run — не даёт
-- двум параллельным прогонам ОДНОГО И ТОГО ЖЕ джоба (двойной клик
-- оператора по кнопке ручного запуска в админке, либо совпадение с
-- расписанием Vercel Cron) обработать разные строки одной и той же
-- партии одновременно и вместе проскочить дневной денежный лимит. Один
-- ряд на jobKey, lockedUntil — TTL-замок (тот же приём, что уже
-- используется на уровне отдельной строки во всех трёх воркерах).

CREATE TABLE "cron_job_locks" (
    "jobKey" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cron_job_locks_pkey" PRIMARY KEY ("jobKey")
);
