-- Этап 80 (doc/SOCIAL-FEED-SPEC.md, TODO §III.9): лента опубликованных
-- роликов внутри TMA — надстройка над уже существующей SharedVideoPage
-- (этап 60). Лайк привязан к Telegram-пользователю (защита от накрутки),
-- один лайк на пару (userId, sharedVideoPageId).
ALTER TABLE "shared_video_pages" ADD COLUMN "likeCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "shared_video_pages" ADD COLUMN "shareCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "shared_video_likes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sharedVideoPageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_video_likes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shared_video_likes_userId_sharedVideoPageId_key" ON "shared_video_likes"("userId", "sharedVideoPageId");
CREATE INDEX "shared_video_likes_sharedVideoPageId_idx" ON "shared_video_likes"("sharedVideoPageId");

ALTER TABLE "shared_video_likes" ADD CONSTRAINT "shared_video_likes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shared_video_likes" ADD CONSTRAINT "shared_video_likes_sharedVideoPageId_fkey" FOREIGN KEY ("sharedVideoPageId") REFERENCES "shared_video_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
