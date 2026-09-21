-- ТЗ на живой аукцион §7.2/§7.3 (антиснайпер) — по запросу реализован
-- ОПЦИОНАЛЬНО, с явным чекбоксом продавца при подаче заявки, а не как
-- поведение по умолчанию для всех BLITZ-лотов, как в исходном ТЗ.
-- Аддитивная миграция, ни одна существующая колонка не трогается.

-- AlterTable
ALTER TABLE "auction_listings" ADD COLUMN "antiSnipeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "auction_listings" ADD COLUMN "extensions" INTEGER NOT NULL DEFAULT 0;
