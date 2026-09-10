-- Этап 62 (ТЗ §41, doc/TODO.md §III.3). Реальная оплата: подписки
-- Standard/Premium через Telegram Stars и WayForPay, разовые пакеты
-- кредитов на генерацию. Payment — история платежей (не удаляется),
-- Subscription — текущее состояние подписки (одна активная на
-- пользователя), CreditLedger — add-only леджер купленных/потраченных
-- кредитов.

CREATE TYPE "PaymentMethod" AS ENUM ('STARS', 'WAYFORPAY');
CREATE TYPE "PaymentPurpose" AS ENUM ('SUBSCRIPTION', 'CREDIT_PACK');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');
-- RENEWING (Г-2.7 аудита round4, этап 64) — временный claim-статус
-- атомарного захвата строки перед списанием картой, см. комментарий в
-- schema.prisma.
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED', 'RENEWING');
CREATE TYPE "CreditLedgerReason" AS ENUM ('PURCHASE', 'CONSUME', 'REFUND', 'ADMIN_ADJUST');

-- Subscription создаётся раньше Payment.subscriptionId её ссылается, но
-- Payment создаётся раньше Subscription по времени выполнения приложения
-- (checkout пишет Payment(PENDING) до первого успешного продления) — в
-- SQL порядок таблиц не важен, FK между ними достаточно объявить в конце.

CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" "UserPlan" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "recTokenEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subscriptions_userId_key" ON "subscriptions"("userId");
CREATE INDEX "subscriptions_status_currentPeriodEnd_idx" ON "subscriptions"("status", "currentPeriodEnd");

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "purpose" "PaymentPurpose" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "plan" "UserPlan",
    "creditsGranted" INTEGER,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "amountMicroUsd" INTEGER,
    "providerRef" TEXT NOT NULL,
    "rawPayload" JSONB,
    "failureReason" TEXT,
    "subscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payments_method_providerRef_key" ON "payments"("method", "providerRef");
CREATE INDEX "payments_userId_createdAt_idx" ON "payments"("userId", "createdAt");
CREATE INDEX "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "credit_ledger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "CreditLedgerReason" NOT NULL,
    "paymentId" TEXT,
    "generatedVideoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credit_ledger_generatedVideoId_reason_key" ON "credit_ledger"("generatedVideoId", "reason");
-- Г-2.5 (аудит round4, этап 64): ключ идемпотентности начисления за
-- оплату — одна строка PURCHASE на один Payment, даже при повторном
-- вызове applySuccessfulPayment (ретрай вебхука после сбоя между
-- обновлением статуса платежа и начислением кредитов).
CREATE UNIQUE INDEX "credit_ledger_paymentId_reason_key" ON "credit_ledger"("paymentId", "reason");
CREATE INDEX "credit_ledger_userId_idx" ON "credit_ledger"("userId");

ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
