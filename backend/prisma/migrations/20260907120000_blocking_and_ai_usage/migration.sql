-- Блокировка пользователя (ТЗ §25.3) и журнал расходов на ИИ (ТЗ §26),
-- этап 31. Написана вручную (нет доступа к binaries.prisma.sh);
-- соответствует schema.prisma.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "isBlocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "blockedAt" TIMESTAMP(3),
ADD COLUMN "blockedReason" TEXT;

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 1,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "pricingVersion" TEXT NOT NULL,
    "unpriced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_userId_createdAt_idx" ON "ai_usage"("userId", "createdAt");
CREATE INDEX "ai_usage_createdAt_idx" ON "ai_usage"("createdAt");
CREATE INDEX "ai_usage_provider_idx" ON "ai_usage"("provider");
CREATE INDEX "ai_usage_sessionId_idx" ON "ai_usage"("sessionId");

-- AddForeignKey
-- SET NULL, а не CASCADE: расход уже понесён, и удаление пользователя не
-- должно стирать историю затрат на него.
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
