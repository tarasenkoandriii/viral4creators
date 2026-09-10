-- Библиотека разборов Gemini (ТЗ §21) и принятие оферты (ТЗ §20) — этап 24.
-- Написана вручную (нет доступа к binaries.prisma.sh); соответствует schema.prisma.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN "termsVersion" TEXT;

-- CreateTable
CREATE TABLE "analysis_library" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "title" TEXT,
    "thumbnailUrl" TEXT,
    "analysis" JSONB NOT NULL,
    "category" TEXT,
    "audienceGender" TEXT,
    "audienceAgeRange" TEXT,
    "audienceInterests" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aspectRatio" TEXT,
    "sceneCount" INTEGER NOT NULL DEFAULT 0,
    "characterCount" INTEGER NOT NULL DEFAULT 0,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "sessionId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analysis_library_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "analysis_library_sourceKey_key" ON "analysis_library"("sourceKey");

-- CreateIndex
CREATE INDEX "analysis_library_category_idx" ON "analysis_library"("category");

-- CreateIndex
CREATE INDEX "analysis_library_audienceGender_idx" ON "analysis_library"("audienceGender");

-- CreateIndex
CREATE INDEX "analysis_library_createdAt_idx" ON "analysis_library"("createdAt");

-- CreateIndex
CREATE INDEX "analysis_library_userId_idx" ON "analysis_library"("userId");

-- AddForeignKey
ALTER TABLE "analysis_library" ADD CONSTRAINT "analysis_library_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
