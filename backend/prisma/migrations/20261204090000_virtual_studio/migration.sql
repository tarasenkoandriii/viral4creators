-- docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md §2, Этап 1-3 —
-- переиспользуемая «студия»: референс-кадр + видео/голос/анализ-фрагменты.
-- Только Этапы 1-3 (админский инструмент); привязка к живому аукциону
-- (Этап 5) в эту миграцию не входит.
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md), `prisma migrate diff --exit-code` в CI
-- проверит, что она не разошлась со schema.prisma.

CREATE TYPE "VirtualStudioFragmentKind" AS ENUM ('VIDEO', 'VOICE', 'ANALYSIS');

CREATE TYPE "VirtualStudioStatus" AS ENUM ('DRAFT', 'READY', 'ARCHIVED');

CREATE TABLE "virtual_studios" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "refPrompt" TEXT NOT NULL,
    "selectedVariantId" TEXT,
    "status" "VirtualStudioStatus" NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "virtual_studios_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "virtual_studios_deletedAt_idx" ON "virtual_studios"("deletedAt");

CREATE TABLE "virtual_studio_variants" (
    "id" TEXT NOT NULL,
    "studioId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "virtual_studio_variants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "virtual_studio_variants_studioId_idx" ON "virtual_studio_variants"("studioId");

CREATE TABLE "virtual_studio_fragments" (
    "id" TEXT NOT NULL,
    "studioId" TEXT NOT NULL,
    "variantId" TEXT,
    "kind" "VirtualStudioFragmentKind" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT NOT NULL,
    "voiceId" TEXT,
    "text" TEXT,
    "sourceVideoUrl" TEXT,
    "brandManifestId" TEXT,
    "resultUrl" TEXT,
    "resultText" TEXT,
    "providerJobId" TEXT,
    "durationSec" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "virtual_studio_fragments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "virtual_studio_fragments_studioId_idx" ON "virtual_studio_fragments"("studioId");

CREATE INDEX "virtual_studio_fragments_kind_status_idx" ON "virtual_studio_fragments"("kind", "status");

ALTER TABLE "virtual_studio_variants" ADD CONSTRAINT "virtual_studio_variants_studioId_fkey"
    FOREIGN KEY ("studioId") REFERENCES "virtual_studios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "virtual_studio_fragments" ADD CONSTRAINT "virtual_studio_fragments_studioId_fkey"
    FOREIGN KEY ("studioId") REFERENCES "virtual_studios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "virtual_studio_fragments" ADD CONSTRAINT "virtual_studio_fragments_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "virtual_studio_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "virtual_studio_fragments" ADD CONSTRAINT "virtual_studio_fragments_brandManifestId_fkey"
    FOREIGN KEY ("brandManifestId") REFERENCES "brand_manifests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
