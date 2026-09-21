-- Аудит-фикс (см. docs-tz/AUDIT-Auction-Money-Currency.md): денежные
-- поля аукциона были DOUBLE PRECISION (Float) — двоичная плавающая
-- точка накапливает ошибку округления на деньгах. Переводим на INTEGER
-- в МИНОРНЫХ единицах (копейки/центы) — та же конвенция, что у
-- Payment.amount (BillingService/WayForPay), а не Decimal(12,2),
-- который в этой схеме используется только для полей бюджета проекта,
-- не для реальных платежей.
--
-- USING ROUND(x * 100)::INTEGER — конвертирует уже накопленные
-- существующие значения (мажорные единицы) в минорные без потери
-- данных; ROUND(), а не усечение, чтобы не потерять последнюю копейку
-- на значениях вроде 19.995 (уже не должно встречаться на аукционе, но
-- на всякий случай — Float мог такое накопить). DTO/API остаются в
-- мажорных единицах — конвертация происходит только в сервисном слое
-- (AuctionService/AuctionPaymentService), эта миграция не трогает
-- контракт наружу.
--
-- PortfolioItem.soldPrice НЕ мигрируется этой миграцией: остаётся
-- Float в МАЖОРНЫХ единицах — read-only витринное поле для карточки
-- «Продано» (/my-portfolio), уже отдаётся наружу в API как есть;
-- сервисный слой при записи в него теперь явно конвертирует
-- AuctionPayment.amount (минорные) обратно в мажорные перед записью.

-- AlterTable: auction_listings
ALTER TABLE "auction_listings" ALTER COLUMN "startingPrice" TYPE INTEGER USING ROUND("startingPrice" * 100)::INTEGER;
ALTER TABLE "auction_listings" ALTER COLUMN "reservePrice" TYPE INTEGER USING ROUND("reservePrice" * 100)::INTEGER;
ALTER TABLE "auction_listings" ALTER COLUMN "buyNowPrice" TYPE INTEGER USING ROUND("buyNowPrice" * 100)::INTEGER;

-- AlterTable: auction_bids
ALTER TABLE "auction_bids" ALTER COLUMN "amount" TYPE INTEGER USING ROUND("amount" * 100)::INTEGER;

-- AlterTable: auction_payments
ALTER TABLE "auction_payments" ALTER COLUMN "amount" TYPE INTEGER USING ROUND("amount" * 100)::INTEGER;
ALTER TABLE "auction_payments" ALTER COLUMN "commission" TYPE INTEGER USING ROUND("commission" * 100)::INTEGER;
