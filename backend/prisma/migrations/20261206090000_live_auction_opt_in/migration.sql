-- docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md §7, ПРАВКА 1.4 — по
-- прямому запросу: живой эфир имеет смысл только для BLITZ-лотов (решает
-- открытый вопрос §7.3 версии 1.2), плюс продавец должен явно согласиться
-- на живую трансляцию своего лота через чекбокс при подаче заявки — тот
-- же приём, что antiSnipeEnabled (20261203090000_auction_anti_snipe).
--
-- Аддитивная миграция: ни одна существующая колонка не трогается.
-- BLITZ-ограничение проверяется в сервисе (AuctionService.
-- assignVirtualStudio), не на уровне схемы — новой колонки для него не
-- требуется, auctionType уже есть с §22.

ALTER TABLE "auction_listings" ADD COLUMN "liveStreamOptIn" BOOLEAN NOT NULL DEFAULT false;
