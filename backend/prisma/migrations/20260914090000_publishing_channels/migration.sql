-- Этап 61 (ТЗ §14, doc/TODO.md §III.2). Выгрузка одобренных заявок
-- (PublicationRequest, этап 18a) в YouTube и TikTok: подключённые каналы
-- проекта/бренда (OAuth-гранты, токены зашифрованы), поля воркера выгрузки
-- на самой заявке (channelId/attempts/nextAttemptAt/uploadJobId/privacy),
-- канал по умолчанию на Project и BrandManifest.

CREATE TYPE "PublicationPrivacy" AS ENUM ('PRIVATE', 'UNLISTED', 'PUBLIC');
CREATE TYPE "ChannelStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

CREATE TABLE "publishing_channels" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "PublicationPlatform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "status" "ChannelStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publishing_channels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "publishing_channels_platform_externalId_key" ON "publishing_channels"("platform", "externalId");
CREATE INDEX "publishing_channels_userId_idx" ON "publishing_channels"("userId");

ALTER TABLE "publishing_channels" ADD CONSTRAINT "publishing_channels_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PublicationRequest: поля выгрузки.
ALTER TABLE "publication_requests"
    ADD COLUMN "channelId" TEXT,
    ADD COLUMN "privacy" "PublicationPrivacy" NOT NULL DEFAULT 'PRIVATE',
    ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
    ADD COLUMN "uploadJobId" TEXT,
    -- Г-2.11 (аудит round4, этап 64): claim строки воркером выгрузки —
    -- см. комментарий у поля в schema.prisma.
    ADD COLUMN "lockedUntil" TIMESTAMP(3);

CREATE INDEX "publication_requests_channelId_idx" ON "publication_requests"("channelId");
CREATE INDEX "publication_requests_status_channelId_nextAttemptAt_idx" ON "publication_requests"("status", "channelId", "nextAttemptAt");

ALTER TABLE "publication_requests" ADD CONSTRAINT "publication_requests_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "publishing_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Project: канал по умолчанию (первый приоритет разрешения).
ALTER TABLE "projects"
    ADD COLUMN "youtubeChannelId" TEXT,
    ADD COLUMN "tiktokChannelId" TEXT;

CREATE INDEX "projects_youtubeChannelId_idx" ON "projects"("youtubeChannelId");
CREATE INDEX "projects_tiktokChannelId_idx" ON "projects"("tiktokChannelId");

ALTER TABLE "projects" ADD CONSTRAINT "projects_youtubeChannelId_fkey"
    FOREIGN KEY ("youtubeChannelId") REFERENCES "publishing_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_tiktokChannelId_fkey"
    FOREIGN KEY ("tiktokChannelId") REFERENCES "publishing_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- BrandManifest: канал по умолчанию (второй приоритет разрешения).
ALTER TABLE "brand_manifests"
    ADD COLUMN "youtubeChannelId" TEXT,
    ADD COLUMN "tiktokChannelId" TEXT;

CREATE INDEX "brand_manifests_youtubeChannelId_idx" ON "brand_manifests"("youtubeChannelId");
CREATE INDEX "brand_manifests_tiktokChannelId_idx" ON "brand_manifests"("tiktokChannelId");

ALTER TABLE "brand_manifests" ADD CONSTRAINT "brand_manifests_youtubeChannelId_fkey"
    FOREIGN KEY ("youtubeChannelId") REFERENCES "publishing_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "brand_manifests" ADD CONSTRAINT "brand_manifests_tiktokChannelId_fkey"
    FOREIGN KEY ("tiktokChannelId") REFERENCES "publishing_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
