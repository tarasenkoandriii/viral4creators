-- Водяной знак на публичном превью портфолио/аукциона (защита от
-- пиратства, ТЗ на маркетплейс §9/§22) — аддитивная миграция, ни одна
-- существующая колонка не теряется. Применяется к PortfolioItem, а не
-- к AuctionListing отдельно: аукцион ссылается на ту же работу.

-- CreateEnum
CREATE TYPE "WatermarkMode" AS ENUM ('SITE_NAME', 'CUSTOM', 'NONE');

-- CreateEnum
CREATE TYPE "WatermarkIntensity" AS ENUM ('SLIGHT', 'STANDARD', 'STRONG');

-- CreateEnum
CREATE TYPE "WatermarkStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "portfolio_items" ADD COLUMN "watermarkMode" "WatermarkMode" NOT NULL DEFAULT 'SITE_NAME';
ALTER TABLE "portfolio_items" ADD COLUMN "watermarkText" TEXT;
ALTER TABLE "portfolio_items" ADD COLUMN "watermarkIntensity" "WatermarkIntensity" NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "portfolio_items" ADD COLUMN "watermarkStatus" "WatermarkStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "portfolio_items" ADD COLUMN "watermarkedVideoUrl" TEXT;
ALTER TABLE "portfolio_items" ADD COLUMN "watermarkJobId" TEXT;
