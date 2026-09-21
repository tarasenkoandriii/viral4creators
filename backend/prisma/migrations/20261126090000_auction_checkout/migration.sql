-- Аукцион — self-serve чек-аут через billing (ТЗ на маркетплейс §22,
-- продолжение Этапа 2). Раньше AuctionPayment.paymentId был свободной
-- строкой без связи; теперь это настоящий FK на "payments" (WayForPay,
-- уже протестированный провайдер — см. BillingService.startAuctionCheckout).
-- Аддитивная миграция — ни одна строка Payment не теряет данных.

-- AlterEnum
ALTER TYPE "PaymentPurpose" ADD VALUE 'AUCTION';

-- AlterTable: paymentId уже существует (TEXT, nullable) из
-- 20261125090000_auction_stage1 — здесь он получает уникальность и FK.
CREATE UNIQUE INDEX "auction_payments_paymentId_key" ON "auction_payments"("paymentId");

-- AddForeignKey
ALTER TABLE "auction_payments" ADD CONSTRAINT "auction_payments_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
