-- Очередь публикации с модерацией — ТЗ §8 (Todo) / §11 «Опубликовать»,
-- этап 18 плана, часть без интеграций (OAuth/upload — отдельное ТЗ).
-- Написано вручную (см. doc/TELEGRAM-ADMIN.md §5); schema.prisma
-- провалидирована `prisma validate`, SQL применён к локальному Postgres 16
-- девятым по порядку.

-- CreateEnum
CREATE TYPE "PublicationPlatform" AS ENUM ('YOUTUBE', 'TIKTOK');

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "publication_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "generatedVideoId" TEXT NOT NULL,
    "projectId" TEXT,
    "productItemId" TEXT,
    "platform" "PublicationPlatform" NOT NULL,
    "status" "PublicationStatus" NOT NULL DEFAULT 'PENDING',
    "videoUrl" TEXT NOT NULL,
    "videoPathname" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tags" TEXT[],
    "category" TEXT,
    "moderatorId" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "externalUrl" TEXT,
    "externalId" TEXT,
    "publishError" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publication_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: очередь оператора — по статусу и времени постановки.
CREATE INDEX "publication_requests_status_createdAt_idx" ON "publication_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "publication_requests_userId_idx" ON "publication_requests"("userId");

-- CreateIndex: «есть ли уже заявка по этой сессии» с фронта.
CREATE INDEX "publication_requests_sessionId_idx" ON "publication_requests"("sessionId");

-- AddForeignKey: автор — Cascade (заявка без автора не нужна).
ALTER TABLE "publication_requests" ADD CONSTRAINT "publication_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: проект/товар — SetNull, заявка самодостаточна (снимок).
ALTER TABLE "publication_requests" ADD CONSTRAINT "publication_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "publication_requests" ADD CONSTRAINT "publication_requests_productItemId_fkey" FOREIGN KEY ("productItemId") REFERENCES "product_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: модератор — SetNull (история решения остаётся).
ALTER TABLE "publication_requests" ADD CONSTRAINT "publication_requests_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
