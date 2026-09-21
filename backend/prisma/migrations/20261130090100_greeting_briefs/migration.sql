-- ТЗ TZ-Greeting-Video-Project-Type.md §3.2 — бриф ролика-поздравления.
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md), `prisma migrate diff --exit-code` в CI
-- проверит, что она не разошлась со schema.prisma.

CREATE TYPE "GreetingOccasion" AS ENUM ('BIRTHDAY', 'WEDDING', 'ANNIVERSARY', 'NEW_YEAR', 'GRADUATION', 'CORPORATE', 'OTHER');

CREATE TYPE "GreetingTone" AS ENUM ('WARM', 'FUNNY', 'FORMAL');

-- Один бриф на проект обеспечивается UNIQUE на "projectId" (§3.2: «1:1 к
-- Project, не список карточек, как ProductItem у LINE») — тот же приём,
-- что у "client_site_tutorial_drafts_projectId_key".
CREATE TABLE "greeting_briefs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "occasion" "GreetingOccasion" NOT NULL,
    "customOccasionText" TEXT,
    "recipientName" TEXT NOT NULL,
    "senderName" TEXT,
    "tone" "GreetingTone" NOT NULL DEFAULT 'WARM',
    "personalMessage" TEXT,
    "presenterProvider" TEXT NOT NULL DEFAULT 'grok',
    "resolution" TEXT NOT NULL DEFAULT '720p',
    "brandManifestId" TEXT,
    "occasionDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "greeting_briefs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "greeting_briefs_projectId_key" ON "greeting_briefs"("projectId");

CREATE INDEX "greeting_briefs_brandManifestId_idx" ON "greeting_briefs"("brandManifestId");

ALTER TABLE "greeting_briefs" ADD CONSTRAINT "greeting_briefs_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "greeting_briefs" ADD CONSTRAINT "greeting_briefs_brandManifestId_fkey"
    FOREIGN KEY ("brandManifestId") REFERENCES "brand_manifests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
