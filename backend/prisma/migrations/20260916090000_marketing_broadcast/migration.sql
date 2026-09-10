-- Этап 63 (ТЗ §42, doc/TODO.md §III.4). Рекламный канал в Telegram:
-- добровольная рассылка подборки удачных роликов подписчикам, не чаще
-- раза в N дней. MarketingBroadcast — снимок одного выпуска (id
-- показанных страниц), MarketingDelivery — состояние доставки этого
-- выпуска одному подписчику (с бэкоффом по строке, тот же приём, что у
-- publication_requests, этап 61). Согласие/отписка живут прямо на users.

ALTER TABLE "users"
    ADD COLUMN "marketingConsentAt" TIMESTAMP(3),
    ADD COLUMN "marketingConsentRevokedAt" TIMESTAMP(3);

ALTER TABLE "shared_video_pages"
    ADD COLUMN "featuredInBroadcastAt" TIMESTAMP(3);

CREATE INDEX "shared_video_pages_status_featuredInBroadcastAt_idx" ON "shared_video_pages"("status", "featuredInBroadcastAt");

CREATE TYPE "MarketingDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "marketing_broadcasts" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sharedVideoPageIds" TEXT[],

    CONSTRAINT "marketing_broadcasts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "marketing_deliveries" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "MarketingDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "marketing_deliveries_broadcastId_userId_key" ON "marketing_deliveries"("broadcastId", "userId");
CREATE INDEX "marketing_deliveries_status_nextAttemptAt_idx" ON "marketing_deliveries"("status", "nextAttemptAt");

ALTER TABLE "marketing_deliveries" ADD CONSTRAINT "marketing_deliveries_broadcastId_fkey"
    FOREIGN KEY ("broadcastId") REFERENCES "marketing_broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketing_deliveries" ADD CONSTRAINT "marketing_deliveries_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
