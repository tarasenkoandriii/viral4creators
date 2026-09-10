-- Этап 57 (ТЗ §35–36, doc/TODO.md §II.3–II.4). Блог: черновики из
-- YoutubeSearchService + разбор Gemini, модерация оператором, перевод на
-- четыре не-оригинальные локали через Batch API xAI Grok (§35.1).

CREATE TYPE "BlogPostStatus" AS ENUM ('DRAFT', 'APPROVED', 'PUBLISHED', 'REJECTED');
CREATE TYPE "BlogPostSource" AS ENUM ('YOUTUBE_TREND', 'MANUAL');
CREATE TYPE "BlogTranslationStatus" AS ENUM ('PENDING', 'QUEUED', 'READY', 'FAILED');
CREATE TYPE "GrokBatchJobStatus" AS ENUM ('SUBMITTED', 'COMPLETED', 'FAILED');

-- Очередь пачек xAI заводится ПЕРВОЙ: blog_post_translations ссылается
-- на неё, а не наоборот.
CREATE TABLE "grok_batch_jobs" (
    "id" TEXT NOT NULL,
    "xaiBatchId" TEXT,
    "status" "GrokBatchJobStatus" NOT NULL DEFAULT 'SUBMITTED',
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grok_batch_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "grok_batch_jobs_xaiBatchId_key" ON "grok_batch_jobs"("xaiBatchId");
CREATE INDEX "grok_batch_jobs_status_idx" ON "grok_batch_jobs"("status");

CREATE TABLE "blog_posts" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "BlogPostStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "BlogPostSource" NOT NULL,
    "category" TEXT NOT NULL,
    "youtubeVideoId" TEXT,
    "youtubeChannelTitle" TEXT,
    "youtubeViewCount" INTEGER,
    "thumbnailUrl" TEXT,
    "score" DOUBLE PRECISION,
    "scoreReasoning" TEXT,
    "originalLocale" TEXT NOT NULL DEFAULT 'ru',
    "title" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "moderatorId" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_posts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blog_posts_slug_key" ON "blog_posts"("slug");
CREATE UNIQUE INDEX "blog_posts_youtubeVideoId_key" ON "blog_posts"("youtubeVideoId");
CREATE INDEX "blog_posts_status_createdAt_idx" ON "blog_posts"("status", "createdAt");
CREATE INDEX "blog_posts_category_idx" ON "blog_posts"("category");
CREATE INDEX "blog_posts_publishedAt_idx" ON "blog_posts"("publishedAt");

ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_moderatorId_fkey"
    FOREIGN KEY ("moderatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "blog_post_translations" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "status" "BlogTranslationStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT,
    "bodyHtml" TEXT,
    "batchJobId" TEXT,
    "errorMessage" TEXT,
    "translatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_post_translations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blog_post_translations_postId_locale_key" ON "blog_post_translations"("postId", "locale");
CREATE INDEX "blog_post_translations_status_idx" ON "blog_post_translations"("status");
CREATE INDEX "blog_post_translations_batchJobId_idx" ON "blog_post_translations"("batchJobId");

ALTER TABLE "blog_post_translations" ADD CONSTRAINT "blog_post_translations_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "blog_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blog_post_translations" ADD CONSTRAINT "blog_post_translations_batchJobId_fkey"
    FOREIGN KEY ("batchJobId") REFERENCES "grok_batch_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Суточный потолок YouTube-поисков генератора блога — своя таблица, а не
-- rate_limits (её чистит крон раз в час, окна рассчитаны на минуты) и не
-- youtube_search_usage (требует userId, у генератора его нет).
CREATE TABLE "blog_youtube_search_usage" (
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_youtube_search_usage_pkey" PRIMARY KEY ("day")
);
