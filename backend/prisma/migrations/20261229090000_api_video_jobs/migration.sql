-- Заявки внешнего API на ролик (этап 145,
-- docs-tz/TZ-Vneshnee-API.md).
--
-- Генерация длится минуты, HTTP-запрос столько не живёт, а фона у
-- serverless нет: ответ — `202` и `jobId`, работу доводит крон. Сессия
-- для этого не годится — её чистит TTL через сутки простоя, а заявка
-- обязана пережить свой результат: по `jobId` придут и завтра. Поэтому
-- `sessionId` здесь БЕЗ внешнего ключа, как у заявки на публикацию.
--
-- `idempotencyKey` уникален В ПАРЕ с пользователем: чужой клиент
-- выбирает его сам, и общая уникальность означала бы, что один
-- интегратор может занять ключ другому. Рядом лежит отпечаток тела:
-- тот же ключ с другим телом — не повтор, а переиспользованный ключ,
-- и молча отдать в ответ чужой ролик значит спрятать ошибку до
-- момента, когда она будет стоить дорого.
CREATE TYPE "ApiVideoJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

CREATE TABLE "api_video_jobs" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,

  "idempotencyKey" TEXT,
  "fingerprint" TEXT NOT NULL,

  "productItemId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "libraryEntryId" TEXT NOT NULL,
  "quality" TEXT NOT NULL,
  "aspectRatio" TEXT,
  "locale" TEXT,

  "sessionId" TEXT,
  "status" "ApiVideoJobStatus" NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "lockedUntil" TIMESTAMP(3),
  "videoUrl" TEXT,
  "error" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_video_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_video_jobs_userId_idempotencyKey_key"
  ON "api_video_jobs"("userId", "idempotencyKey");
CREATE INDEX "api_video_jobs_status_nextAttemptAt_idx"
  ON "api_video_jobs"("status", "nextAttemptAt");
CREATE INDEX "api_video_jobs_userId_idx" ON "api_video_jobs"("userId");

ALTER TABLE "api_video_jobs"
  ADD CONSTRAINT "api_video_jobs_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
