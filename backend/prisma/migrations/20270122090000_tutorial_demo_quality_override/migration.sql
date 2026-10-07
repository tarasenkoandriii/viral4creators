-- Проверка качества демо, заход 7 (07.10.2026; doc/TUTORIAL-DEMO-QUALITY-SPEC.md):
-- переопределение вердикта оператором с причиной и журналом, контрольные
-- кадры шагов, чёрные/замершие кадры декодером ffmpeg-api.
--
-- Журнал переопределений переживает проверку: удаление ролика каскадом
-- снимает проверки, а строки журнала остаются с `checkId = NULL`.
--
-- Написана руками (doc/CI.md); `prisma migrate diff --exit-code` в CI
-- сверит её со schema.prisma. Старые строки не трогаются: колонки
-- допускают NULL, переопределений у них нет.
ALTER TABLE "tutorial_demo_quality_checks"
    ADD COLUMN "overrideVerdict" TEXT,
    ADD COLUMN "overrideReason" TEXT,
    ADD COLUMN "overrideBy" TEXT,
    ADD COLUMN "overrideAt" TIMESTAMP(3),
    ADD COLUMN "controlFrames" JSONB,
    ADD COLUMN "signalsStatus" TEXT,
    ADD COLUMN "signalsJobId" TEXT,
    ADD COLUMN "signalsStartedAt" TIMESTAMP(3),
    ADD COLUMN "signals" JSONB;

CREATE TABLE "tutorial_demo_quality_overrides" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkId" TEXT,
    "assetId" TEXT NOT NULL,
    "fromVerdict" TEXT,
    "toVerdict" TEXT,
    "reason" TEXT NOT NULL,
    "by" TEXT NOT NULL,

    CONSTRAINT "tutorial_demo_quality_overrides_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tutorial_demo_quality_overrides_checkId_createdAt_idx" ON "tutorial_demo_quality_overrides"("checkId", "createdAt");

CREATE INDEX "tutorial_demo_quality_overrides_assetId_createdAt_idx" ON "tutorial_demo_quality_overrides"("assetId", "createdAt");

ALTER TABLE "tutorial_demo_quality_overrides" ADD CONSTRAINT "tutorial_demo_quality_overrides_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "tutorial_demo_quality_checks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
