-- WP3 Story-Tales: повод (пресет + тема), явное включение реплики о подарке,
-- описание фото подарка, раскладка сегментов озвучки для видео (WP4).
ALTER TABLE "story_gifts"
  ADD COLUMN "occasionKind" TEXT,
  ADD COLUMN "occasionTheme" TEXT,
  ADD COLUMN "giftNoteEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "giftPhotoDescription" TEXT,
  ADD COLUMN "narrationLayout" JSONB;

-- Прежние реплики уже были озвучены по явному вводу взрослого: считаем их включёнными.
UPDATE "story_gifts" SET "giftNoteEnabled" = true WHERE "giftNote" IS NOT NULL;

ALTER TABLE "story_gifts"
  ADD CONSTRAINT "story_occasion_kind" CHECK ("occasionKind" IS NULL OR "occasionKind" IN ('birthday','bedtime','separation','support','other')),
  ADD CONSTRAINT "story_occasion_theme" CHECK ("occasionTheme" IS NULL OR "occasionTheme" IN ('calm','celebration','night','warm','gentle')),
  ADD CONSTRAINT "story_gift_note_enabled" CHECK ("giftNote" IS NULL OR "giftNoteEnabled"),
  ADD CONSTRAINT "story_gift_note_position" CHECK ("giftNotePosition" IS NULL OR "giftNotePosition" IN ('beginning','end')),
  ADD CONSTRAINT "story_gift_photo_description" CHECK ("giftPhotoDescription" IS NULL OR char_length("giftPhotoDescription") <= 200),
  ADD CONSTRAINT "story_narration_layout" CHECK ("narrationLayout" IS NULL OR (jsonb_typeof("narrationLayout") = 'object' AND "narrationLayout"->>'version' = '1'));
