-- Подтверждение прав на эксклюзивную перепродажу (ТЗ на маркетплейс
-- §22.6) — самозаявление исполнителя при подаче заявки, не проверка
-- платформой. Обязательно для НОВЫХ заявок (сервис отклоняет без
-- флага), но у уже существующих строк поля ещё нет — добавляем в три
-- шага (nullable → backfill → NOT NULL), а не одной ADD COLUMN NOT NULL
-- без дефолта, которая упала бы на непустой таблице.

-- AlterTable (шаг 1 — временно nullable)
ALTER TABLE "auction_listings" ADD COLUMN "rightsConfirmedAt" TIMESTAMP(3);

-- Backfill (шаг 2) — для уже существующих заявок (если такие есть)
-- честной даты подтверждения не было физически, дата подачи заявки —
-- ближайшее разумное приближение, не более того.
UPDATE "auction_listings" SET "rightsConfirmedAt" = "createdAt" WHERE "rightsConfirmedAt" IS NULL;

-- AlterTable (шаг 3 — теперь обязательное)
ALTER TABLE "auction_listings" ALTER COLUMN "rightsConfirmedAt" SET NOT NULL;
