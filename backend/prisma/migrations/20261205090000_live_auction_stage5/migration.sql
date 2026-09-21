-- docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md §7, Этап 5 — живой
-- аукцион: привязка студии к лоту, статус эфира, подсказки озвучки.
-- Аддитивная миграция: ни одна существующая колонка/таблица не трогается.
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md), `prisma migrate diff --exit-code` в CI
-- проверит, что она не разошлась со schema.prisma.

-- AlterTable: AuctionListing — студия эфира + статус трансляции.
ALTER TABLE "auction_listings" ADD COLUMN "virtualStudioId" TEXT;
ALTER TABLE "auction_listings" ADD COLUMN "liveStreamActive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "auction_listings" ADD COLUMN "liveStreamStartedAt" TIMESTAMP(3);
ALTER TABLE "auction_listings" ADD COLUMN "liveStreamEndedAt" TIMESTAMP(3);

ALTER TABLE "auction_listings" ADD CONSTRAINT "auction_listings_virtualStudioId_fkey"
    FOREIGN KEY ("virtualStudioId") REFERENCES "virtual_studios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: VirtualStudioFragment — какой лот сейчас "в эфире" с этим
-- видео-фрагментом (§7.1/§7.2, одиночная переназначаемая ссылка).
ALTER TABLE "virtual_studio_fragments" ADD COLUMN "liveAuctionListingId" TEXT;

CREATE INDEX "virtual_studio_fragments_liveAuctionListingId_idx" ON "virtual_studio_fragments"("liveAuctionListingId");

ALTER TABLE "virtual_studio_fragments" ADD CONSTRAINT "virtual_studio_fragments_liveAuctionListingId_fkey"
    FOREIGN KEY ("liveAuctionListingId") REFERENCES "auction_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Подсказки озвучки эфира (§7.2, §7.4).
CREATE TYPE "VoiceCueKind" AS ENUM ('LOT_DESC', 'INVITE', 'PRAISE', 'BID_STATS');

CREATE TYPE "VoiceCueTrigger" AS ENUM ('PREGEN', 'BID');

CREATE TABLE "auction_live_voice_cues" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "VoiceCueKind" NOT NULL,
    "triggeredBy" "VoiceCueTrigger" NOT NULL DEFAULT 'PREGEN',
    "bidId" TEXT,
    "voiceFragmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "auction_live_voice_cues_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auction_live_voice_cues_listingId_seq_key" ON "auction_live_voice_cues"("listingId", "seq");

CREATE INDEX "auction_live_voice_cues_listingId_idx" ON "auction_live_voice_cues"("listingId");

-- bidId @unique в schema.prisma (Bid.voiceCue — единичная ссылка, не список).
CREATE UNIQUE INDEX "auction_live_voice_cues_bidId_key" ON "auction_live_voice_cues"("bidId");

ALTER TABLE "auction_live_voice_cues" ADD CONSTRAINT "auction_live_voice_cues_listingId_fkey"
    FOREIGN KEY ("listingId") REFERENCES "auction_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "auction_live_voice_cues" ADD CONSTRAINT "auction_live_voice_cues_bidId_fkey"
    FOREIGN KEY ("bidId") REFERENCES "auction_bids"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "auction_live_voice_cues" ADD CONSTRAINT "auction_live_voice_cues_voiceFragmentId_fkey"
    FOREIGN KEY ("voiceFragmentId") REFERENCES "virtual_studio_fragments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
