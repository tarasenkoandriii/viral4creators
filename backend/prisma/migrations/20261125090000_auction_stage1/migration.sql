-- Аукцион готовых видео — Этап 1 (ТЗ на маркетплейс §22): только слой
-- данных. Можно начинать независимо от Тендера (Фаза 2, остаётся
-- отложен до сигнала §19.4) — свой лёгкий контур оплаты (AuctionPayment),
-- без Contract/Escrow «Сейф 5%» из отдельного ТЗ на бэкенд §11.3.
-- Аддитивная миграция — ни одна существующая таблица не теряет колонок.

-- AlterEnum
ALTER TYPE "PortfolioStatus" ADD VALUE 'SOLD';

-- AlterTable
ALTER TABLE "portfolio_items" ADD COLUMN "soldAt" TIMESTAMP(3);
ALTER TABLE "portfolio_items" ADD COLUMN "soldPrice" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "brand_manifests" ADD COLUMN "isLocked" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum
CREATE TYPE "AuctionType" AS ENUM ('BLITZ', 'STANDARD');

-- CreateEnum
CREATE TYPE "AuctionListingStatus" AS ENUM ('PENDING_MODERATION', 'QUEUED', 'ACTIVE', 'WON', 'EXPIRED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "auction_listings" (
    "id" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "portfolioItemId" TEXT NOT NULL,
    "brandManifestId" TEXT,
    "includeBrandManifest" BOOLEAN NOT NULL DEFAULT false,
    "auctionType" "AuctionType" NOT NULL DEFAULT 'STANDARD',
    "expiresAt" TIMESTAMP(3),
    "googleAdsCampaignId" TEXT,
    "aiAssessment" TEXT,
    "brandManifestAiAudit" TEXT,
    "startingPrice" DOUBLE PRECISION NOT NULL,
    "reservePrice" DOUBLE PRECISION,
    "buyNowPrice" DOUBLE PRECISION,
    "status" "AuctionListingStatus" NOT NULL DEFAULT 'PENDING_MODERATION',
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auction_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auction_bids" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auction_bids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auction_payments" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "winningBidId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "commission" DOUBLE PRECISION NOT NULL,
    "paymentId" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auction_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auction_listings_status_idx" ON "auction_listings"("status");
CREATE INDEX "auction_listings_creatorProfileId_idx" ON "auction_listings"("creatorProfileId");
CREATE INDEX "auction_listings_portfolioItemId_idx" ON "auction_listings"("portfolioItemId");

CREATE INDEX "auction_bids_listingId_idx" ON "auction_bids"("listingId");
CREATE INDEX "auction_bids_buyerId_idx" ON "auction_bids"("buyerId");

CREATE UNIQUE INDEX "auction_payments_listingId_key" ON "auction_payments"("listingId");
CREATE UNIQUE INDEX "auction_payments_winningBidId_key" ON "auction_payments"("winningBidId");

-- AddForeignKey
ALTER TABLE "auction_listings" ADD CONSTRAINT "auction_listings_creatorProfileId_fkey" FOREIGN KEY ("creatorProfileId") REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auction_listings" ADD CONSTRAINT "auction_listings_portfolioItemId_fkey" FOREIGN KEY ("portfolioItemId") REFERENCES "portfolio_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "auction_listings" ADD CONSTRAINT "auction_listings_brandManifestId_fkey" FOREIGN KEY ("brandManifestId") REFERENCES "brand_manifests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "auction_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auction_payments" ADD CONSTRAINT "auction_payments_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "auction_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "auction_payments" ADD CONSTRAINT "auction_payments_winningBidId_fkey" FOREIGN KEY ("winningBidId") REFERENCES "auction_bids"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
