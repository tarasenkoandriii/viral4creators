-- Темп обучалок в постпродакшене с привязкой озвучки к кадрам
-- (doc/TUTORIAL-POSTPROD-TEMPO-SPEC.md; решение владельца 06.10.2026 —
-- покадровая озвучка обучалок по сайту клиента в этом же этапе).
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md); `prisma migrate diff --exit-code` в CI проверит,
-- что она не разошлась со schema.prisma.
--
-- * `tutorial_video_assets.tempoManifest` — монтажный manifest ролика;
--   NULL у всех прежних строк: темп для них недоступен (non-editable),
--   границы реплик по общей длине файла не угадываются.
-- * `tutorial_video_assets.activeVersionId` — какая версия отдаётся вместо
--   исходного файла; NULL — исходный ролик.
-- * `tutorial_video_versions` — версии с другим темпом. Отдельная таблица:
--   синхронизация сайта помощника, консультант и подметальщик читают
--   только строки роликов и неактивных версий не видят.
-- * `client_site_tutorial_drafts.voiceEnabled` (по умолчанию ВКЛ) и
--   `locale` — покадровая озвучка обучалки по сайту клиента.
ALTER TABLE "tutorial_video_assets"
  ADD COLUMN "tempoManifest" JSONB,
  ADD COLUMN "activeVersionId" TEXT;

ALTER TABLE "client_site_tutorial_drafts"
  ADD COLUMN "voiceEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "locale" TEXT;

CREATE TABLE "tutorial_video_versions" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "assetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tempoFactor" DOUBLE PRECISION,
    "motion" TEXT NOT NULL,
    "manifestVersion" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preparing',
    "error" TEXT,
    "jobId" TEXT,
    "startedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "blobUrl" TEXT,
    "videoMs" INTEGER,
    "probe" JSONB,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "requestedBy" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "tutorial_video_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tutorial_video_versions_assetId_idempotencyKey_key" ON "tutorial_video_versions"("assetId", "idempotencyKey");

CREATE INDEX "tutorial_video_versions_status_idx" ON "tutorial_video_versions"("status");

ALTER TABLE "tutorial_video_versions" ADD CONSTRAINT "tutorial_video_versions_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "tutorial_video_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
