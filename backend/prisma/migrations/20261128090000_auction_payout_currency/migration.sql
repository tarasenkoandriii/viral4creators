-- Валюта выплаты продавцу на аукционе (ТЗ на маркетплейс §22) —
-- аддитивная миграция. Существующие (пока единственно возможные UAH)
-- записи получают явный дефолт, ни одна не теряет данных.

-- CreateEnum
CREATE TYPE "AuctionCurrency" AS ENUM ('UAH', 'USD', 'EUR');

-- AlterTable
ALTER TABLE "auction_listings" ADD COLUMN "payoutCurrency" "AuctionCurrency" NOT NULL DEFAULT 'UAH';
