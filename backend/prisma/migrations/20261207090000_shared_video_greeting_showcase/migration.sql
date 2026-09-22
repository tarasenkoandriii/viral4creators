-- Этап 1 плана docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md —
-- фундамент витрины поздравлений (§5 docs-tz/TZ-Greeting-Video-Landing.md).
--
-- Находка 1.1 аудита: до этой миграции поздравление нельзя было
-- опубликовать публичной страницей ВООБЩЕ — `SharedVideoService.
-- snapshotFromSession` бросал 400 на любую сессию без
-- `productInformation`, а `productName` был NOT NULL на уровне базы, так
-- что одной правкой сервиса обойтись было нельзя.
--
-- Из этого следует полезное свойство: среди строк, существующих на
-- момент миграции, поздравлений нет ни одного. Поэтому backfill
-- `projectType` не нужен — NULL у старых строк означает ровно «товарный
-- ролик», и это не предположение, а следствие прежнего поведения кода.

ALTER TABLE "shared_video_pages" ALTER COLUMN "productName" DROP NOT NULL;

ALTER TABLE "shared_video_pages" ADD COLUMN "projectType" "ProjectType";
ALTER TABLE "shared_video_pages" ADD COLUMN "occasion" "GreetingOccasion";
ALTER TABLE "shared_video_pages" ADD COLUMN "showcasedAt" TIMESTAMP(3);

CREATE INDEX "shared_video_pages_status_projectType_showcasedAt_idx"
  ON "shared_video_pages"("status", "projectType", "showcasedAt");
