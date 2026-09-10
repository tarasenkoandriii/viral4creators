-- Этап 60 (ТЗ §40, doc/TODO.md §III.1). Публичная страница ролика и петля
-- шеринга: снимок готового ролика с собственным Blob-префиксом
-- (переживает TTL-уборку сессий, как и publication_requests), очередь
-- модерации той же формы, счётчики просмотров и конверсии в первую
-- генерацию.

CREATE TYPE "SharedVideoStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED');

CREATE TABLE "shared_video_pages" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "generatedVideoId" TEXT NOT NULL,
    "status" "SharedVideoStatus" NOT NULL DEFAULT 'PENDING',
    "videoUrl" TEXT NOT NULL,
    "videoPathname" TEXT NOT NULL,
    "aspectRatio" TEXT,
    "title" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "productDescription" TEXT,
    "price" DOUBLE PRECISION,
    "currency" TEXT,
    "category" TEXT,
    "productImageUrl" TEXT,
    "productImagePathname" TEXT,
    "locale" TEXT NOT NULL,
    "libraryEntryId" TEXT,
    "moderatorId" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "firstGenerationCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_video_pages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shared_video_pages_status_createdAt_idx" ON "shared_video_pages"("status", "createdAt");
CREATE INDEX "shared_video_pages_userId_idx" ON "shared_video_pages"("userId");
CREATE INDEX "shared_video_pages_sessionId_idx" ON "shared_video_pages"("sessionId");
CREATE INDEX "shared_video_pages_moderatorId_idx" ON "shared_video_pages"("moderatorId");

ALTER TABLE "shared_video_pages" ADD CONSTRAINT "shared_video_pages_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shared_video_pages" ADD CONSTRAINT "shared_video_pages_moderatorId_fkey"
    FOREIGN KEY ("moderatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
