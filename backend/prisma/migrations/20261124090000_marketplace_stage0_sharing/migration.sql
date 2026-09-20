-- ТЗ §20 (20 фич продвижения/шеринга для Этапа 0): ваниti-ссылки,
-- счётчики просмотров, редакционный Featured-бейдж, тематические
-- подборки. Аддитивная миграция.

ALTER TABLE "creator_profiles" ADD COLUMN "slug" TEXT;
ALTER TABLE "creator_profiles" ADD COLUMN "viewCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "creator_profiles" ADD COLUMN "isFeatured" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "creator_profiles_slug_key" ON "creator_profiles"("slug");
CREATE INDEX "creator_profiles_isFeatured_idx" ON "creator_profiles"("isFeatured");

ALTER TABLE "portfolio_items" ADD COLUMN "viewCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "portfolio_items" ADD COLUMN "collectionTag" TEXT;
CREATE INDEX "portfolio_items_collectionTag_idx" ON "portfolio_items"("collectionTag");
