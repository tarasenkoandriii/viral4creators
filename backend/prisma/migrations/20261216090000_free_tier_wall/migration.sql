-- Граница бесплатного: право на рендер и приветственная генерация
-- («Условно бесплатный Lite» §4, §8; этап 132).
--
-- Миграция написана руками, как и все остальные в проекте; CI сверяет
-- её со схемой через `prisma migrate diff --exit-code`.

-- Откуда взялась снятая стена. Читает один — оператор в админке.
CREATE TYPE "LiteUnlockSource" AS ENUM ('EARNED', 'GRANDFATHERED', 'OPERATOR');

ALTER TABLE "users"
  ADD COLUMN "liteUnlockedAt"    TIMESTAMP(3),
  ADD COLUMN "liteUnlockSource"  "LiteUnlockSource",
  ADD COLUMN "liteRevokedAt"     TIMESTAMP(3),
  ADD COLUMN "liteRevokedReason" TEXT;

-- Бесплатные начисления программы. Отдельными причинами, а не одной
-- общей: журнал кредитов — единственное место, по которому потом
-- восстанавливается, за что человеку выдали каждую генерацию.
ALTER TYPE "CreditLedgerReason" ADD VALUE 'WELCOME';
ALTER TYPE "CreditLedgerReason" ADD VALUE 'SUBSCRIPTION';
ALTER TYPE "CreditLedgerReason" ADD VALUE 'REFERRAL';
ALTER TYPE "CreditLedgerReason" ADD VALUE 'REFERRAL_INVITEE';

ALTER TABLE "credit_ledger" ADD COLUMN "referralId" TEXT;

-- По одной строке REFERRAL и REFERRAL_INVITEE на приглашение (этап 134).
-- NULL в referralId не коллидируют, поэтому остальные причины не задеты —
-- тот же приём, что уже применён к generatedVideoId и paymentId.
CREATE UNIQUE INDEX "credit_ledger_referralId_reason_key"
  ON "credit_ledger" ("referralId", "reason");

-- Приветственная генерация — одна на пользователя, НАВСЕГДА.
-- Частичный индекс, а не уникальность по паре (userId, reason): пар
-- CONSUME/REFUND у одного человека сколько угодно, и общий индекс
-- запретил бы вторую генерацию вовсе.
CREATE UNIQUE INDEX "credit_ledger_welcome_once"
  ON "credit_ledger" ("userId")
  WHERE "reason" = 'WELCOME';

-- То же для начисления за подписку (этап 133): подтвердить её можно
-- один раз, и второй генерации за неё не положено.
CREATE UNIQUE INDEX "credit_ledger_subscription_once"
  ON "credit_ledger" ("userId")
  WHERE "reason" = 'SUBSCRIPTION';

-- Предохранитель считает бесплатные начисления за сутки по ВСЕЙ
-- программе, то есть на каждое начисление делает count по таблице,
-- которая растёт с каждой генерацией продукта. Без индекса это
-- последовательный просмотр, и чем лучше идут дела, тем он дороже.
CREATE INDEX "credit_ledger_reason_createdAt_idx"
  ON "credit_ledger" ("reason", "createdAt");

-- Сохранение доступа тем, кому его уже обещали.
--
-- Дата — НЕ now() и не день включения рубильника, а ровно та, что стоит
-- в пункте 6.9.3 оферты (редакция 2026-09-24): код и документ,
-- обещающий человеку сохранение доступа, обязаны называть одну дату.
-- Разойдись они — спор выиграет документ, а объясняться придётся нам.
UPDATE "users"
   SET "liteUnlockedAt" = "createdAt",
       "liteUnlockSource" = 'GRANDFATHERED'
 WHERE "createdAt" < '2026-09-24T00:00:00Z'
   AND "liteUnlockedAt" IS NULL;
