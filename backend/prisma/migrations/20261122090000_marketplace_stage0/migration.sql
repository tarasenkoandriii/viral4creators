-- Маркетплейс исполнителей — Этап 0 / Фаза 1 (ТЗ на маркетплейс §19–§21,
-- ТЗ на бэкенд §2–§3, §10). Только витрина: профили Creator, портфолио,
-- лайки, лёгкий бриф заказчика (CreatorInquiry). Аддитивная миграция — ни
-- одна существующая таблица не меняется, кроме новой колонки "roles" на
-- "users". Tender/Contract/Escrow сознательно не создаются на этом этапе.

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'CREATOR', 'AGENCY_OWNER');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "roles" "UserRole"[] NOT NULL DEFAULT ARRAY[]::"UserRole"[];

-- CreateEnum
CREATE TYPE "PortfolioSourceType" AS ENUM ('SELF_UPLOAD', 'CONTRACT');

-- CreateEnum
CREATE TYPE "PortfolioStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InquiryStatus" AS ENUM ('DRAFT', 'SENT', 'CONTACTED');

-- CreateTable
CREATE TABLE "creator_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "niches" TEXT[],
    "priceRangeMin" DOUBLE PRECISION,
    "priceRangeMax" DOUBLE PRECISION,
    "bio" TEXT,
    "isAcceptingOrders" BOOLEAN NOT NULL DEFAULT true,
    "consentGivenAt" TIMESTAMP(3) NOT NULL,
    "contactHandle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_social_links" (
    "id" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "creator_social_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_items" (
    "id" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "sourceType" "PortfolioSourceType" NOT NULL DEFAULT 'SELF_UPLOAD',
    "contractId" TEXT,
    "inquiryId" TEXT,
    "videoUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "status" "PortfolioStatus" NOT NULL DEFAULT 'PENDING',
    "creatorConsent" BOOLEAN NOT NULL DEFAULT true,
    "customerConsent" BOOLEAN NOT NULL DEFAULT false,
    "anonymized" BOOLEAN NOT NULL DEFAULT false,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "moderatedById" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolio_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_likes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "portfolioItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_inquiries" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "projectId" TEXT,
    "productDescription" TEXT NOT NULL,
    "isProductLine" BOOLEAN NOT NULL DEFAULT false,
    "goal" TEXT,
    "targetPlatform" TEXT NOT NULL,
    "budgetHint" DOUBLE PRECISION,
    "status" "InquiryStatus" NOT NULL DEFAULT 'DRAFT',
    "contactedCreatorId" TEXT,
    "contactedAgencyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "creator_profiles_userId_key" ON "creator_profiles"("userId");
CREATE INDEX "creator_profiles_isAcceptingOrders_idx" ON "creator_profiles"("isAcceptingOrders");

CREATE INDEX "creator_social_links_creatorProfileId_idx" ON "creator_social_links"("creatorProfileId");

CREATE INDEX "portfolio_items_creatorProfileId_status_idx" ON "portfolio_items"("creatorProfileId", "status");
CREATE INDEX "portfolio_items_status_createdAt_idx" ON "portfolio_items"("status", "createdAt");

CREATE UNIQUE INDEX "portfolio_likes_userId_portfolioItemId_key" ON "portfolio_likes"("userId", "portfolioItemId");
CREATE INDEX "portfolio_likes_portfolioItemId_idx" ON "portfolio_likes"("portfolioItemId");

CREATE INDEX "creator_inquiries_customerId_idx" ON "creator_inquiries"("customerId");
CREATE INDEX "creator_inquiries_status_idx" ON "creator_inquiries"("status");

-- AddForeignKey
ALTER TABLE "creator_profiles" ADD CONSTRAINT "creator_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "creator_social_links" ADD CONSTRAINT "creator_social_links_creatorProfileId_fkey" FOREIGN KEY ("creatorProfileId") REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_creatorProfileId_fkey" FOREIGN KEY ("creatorProfileId") REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "portfolio_likes" ADD CONSTRAINT "portfolio_likes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "portfolio_likes" ADD CONSTRAINT "portfolio_likes_portfolioItemId_fkey" FOREIGN KEY ("portfolioItemId") REFERENCES "portfolio_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "creator_inquiries" ADD CONSTRAINT "creator_inquiries_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
