-- Проверка качества демо через Gemini (doc/TUTORIAL-DEMO-QUALITY-SPEC.md,
-- 06.10.2026). Фаза наблюдения: запись только сообщает оператору,
-- одобрение ролика (`tutorial_video_assets.reviewed`) не меняет.
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md); `prisma migrate diff --exit-code` в CI проверит,
-- что она не разошлась со schema.prisma.
--
-- Строк для уже собранных роликов миграция НЕ заводит: проверка ставится
-- в очередь только для новых сборок и по кнопке оператора.
CREATE TABLE "tutorial_demo_quality_checks" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "assetId" TEXT NOT NULL,
    "versionId" TEXT,
    "videoUrl" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "requestedBy" TEXT,
    "contentSha" TEXT,
    "rubricVersion" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "reusedFromId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "phase" TEXT NOT NULL DEFAULT 'upload',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "providerFileName" TEXT,
    "providerFileUri" TEXT,
    "providerFileMime" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "verdict" TEXT,
    "report" JSONB,
    "preflight" JSONB,
    "error" TEXT,
    "costMicroUsd" INTEGER,
    "unpriced" BOOLEAN NOT NULL DEFAULT false,
    "tokenUsage" JSONB,
    "durationMs" INTEGER,
    "theme" TEXT,
    "locale" TEXT NOT NULL,
    "captureBuild" TEXT,
    "captureMode" TEXT,
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "tutorial_demo_quality_checks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tutorial_demo_quality_checks_assetId_createdAt_idx" ON "tutorial_demo_quality_checks"("assetId", "createdAt");

CREATE INDEX "tutorial_demo_quality_checks_status_nextAttemptAt_idx" ON "tutorial_demo_quality_checks"("status", "nextAttemptAt");

CREATE INDEX "tutorial_demo_quality_checks_dedupeKey_idx" ON "tutorial_demo_quality_checks"("dedupeKey");

ALTER TABLE "tutorial_demo_quality_checks" ADD CONSTRAINT "tutorial_demo_quality_checks_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "tutorial_video_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
