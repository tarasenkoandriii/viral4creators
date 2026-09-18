-- ИИ-скетч (doc/AI-SKETCH-SPEC.md §6.1). Миграция аддитивная: ни одна
-- существующая колонка не меняется, данные не переносятся — слот без
-- скетча читается ровно как раньше.

CREATE TABLE "image_sketches" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetSubId" TEXT,
    "mode" TEXT NOT NULL,
    "style" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "sourceHash" TEXT,
    "sourcePathname" TEXT,
    "description" TEXT,
    "model" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "pathname" TEXT,
    "url" TEXT,
    "mimeType" TEXT,
    "status" TEXT NOT NULL,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "image_sketches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "image_sketches_targetType_targetId_targetSubId_idx"
    ON "image_sketches"("targetType", "targetId", "targetSubId");
CREATE INDEX "image_sketches_userId_createdAt_idx"
    ON "image_sketches"("userId", "createdAt");
CREATE INDEX "image_sketches_status_expiresAt_idx"
    ON "image_sketches"("status", "expiresAt");

ALTER TABLE "image_sketches"
    ADD CONSTRAINT "image_sketches_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Слоты: ссылка на применённый скетч и отметка «оригинал удалён».
ALTER TABLE "brand_characters" ADD COLUMN "activeSketchId" TEXT;
ALTER TABLE "brand_characters" ADD COLUMN "originalDeletedAt" TIMESTAMP(3);
ALTER TABLE "brand_scenes" ADD COLUMN "activeSketchId" TEXT;
ALTER TABLE "brand_scenes" ADD COLUMN "originalDeletedAt" TIMESTAMP(3);
ALTER TABLE "product_items" ADD COLUMN "activeSketchId" TEXT;
ALTER TABLE "product_items" ADD COLUMN "originalDeletedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "brand_characters_activeSketchId_key"
    ON "brand_characters"("activeSketchId");
CREATE UNIQUE INDEX "brand_scenes_activeSketchId_key"
    ON "brand_scenes"("activeSketchId");
CREATE UNIQUE INDEX "product_items_activeSketchId_key"
    ON "product_items"("activeSketchId");

ALTER TABLE "brand_characters"
    ADD CONSTRAINT "brand_characters_activeSketchId_fkey" FOREIGN KEY ("activeSketchId")
    REFERENCES "image_sketches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "brand_scenes"
    ADD CONSTRAINT "brand_scenes_activeSketchId_fkey" FOREIGN KEY ("activeSketchId")
    REFERENCES "image_sketches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "product_items"
    ADD CONSTRAINT "product_items_activeSketchId_fkey" FOREIGN KEY ("activeSketchId")
    REFERENCES "image_sketches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
