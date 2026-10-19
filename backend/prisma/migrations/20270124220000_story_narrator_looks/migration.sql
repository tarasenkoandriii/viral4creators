-- WP5 Story-Tales: narrator derived looks (outfit / light makeup) and a separate
-- synthetic-image consent `story-parent-image-v1`. The original brand photo and
-- its sketch are never modified; derived bytes stay private in Postgres.
CREATE TABLE "story_narrator_looks" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "manifestId" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "parentLookId" TEXT,
  "sourceUrl" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "outfit" TEXT NOT NULL,
  "makeup" TEXT NOT NULL,
  "configHash" TEXT NOT NULL,
  "promptHash" TEXT NOT NULL,
  "consentVersion" TEXT NOT NULL,
  "consentAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "imageCalls" INTEGER NOT NULL,
  "reservedMicroUsd" INTEGER NOT NULL,
  "photo" BYTEA,
  "photoMime" TEXT,
  "photoHash" TEXT,
  "style" TEXT,
  "styleOptions" JSONB,
  "styleStatus" TEXT NOT NULL DEFAULT 'NONE',
  "styled" BYTEA,
  "styledMime" TEXT,
  "styledHash" TEXT,
  "model" TEXT,
  "error" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_narrator_looks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "story_narrator_look_state" CHECK ("status" IN ('PENDING','READY','FAILED','UNKNOWN','DELETED')),
  CONSTRAINT "story_narrator_look_style_state" CHECK ("styleStatus" IN ('NONE','PENDING','READY','FAILED','UNKNOWN')),
  CONSTRAINT "story_narrator_look_outfit" CHECK ("outfit" IN ('casual','cozy-home','festive','business','winter')),
  CONSTRAINT "story_narrator_look_makeup" CHECK ("makeup" IN ('none','light','natural')),
  CONSTRAINT "story_narrator_look_style" CHECK ("style" IS NULL OR "style" IN ('pencil','lineart','flat','watercolor','cartoon')),
  CONSTRAINT "story_narrator_look_style_none" CHECK (("style" IS NULL) = ("styleStatus" = 'NONE')),
  CONSTRAINT "story_narrator_look_consent" CHECK ("consentVersion" = 'story-parent-image-v1'),
  CONSTRAINT "story_narrator_look_calls" CHECK ("imageCalls" BETWEEN 1 AND 2 AND "reservedMicroUsd" >= 0),
  CONSTRAINT "story_narrator_look_photo_limit" CHECK (octet_length("photo") <= 4194304),
  CONSTRAINT "story_narrator_look_styled_limit" CHECK (octet_length("styled") <= 4194304),
  CONSTRAINT "story_narrator_look_ready" CHECK ("status" <> 'READY' OR ("photoHash" IS NOT NULL AND ("style" IS NULL OR ("styledHash" IS NOT NULL AND "styleStatus" = 'READY')))),
  CONSTRAINT "story_narrator_look_deleted" CHECK (("status" = 'DELETED') = ("deletedAt" IS NOT NULL) AND ("deletedAt" IS NULL OR ("photo" IS NULL AND "styled" IS NULL)))
);
CREATE INDEX "story_narrator_looks_userId_createdAt_idx" ON "story_narrator_looks"("userId", "createdAt");
CREATE INDEX "story_narrator_looks_manifestId_createdAt_idx" ON "story_narrator_looks"("manifestId", "createdAt");
CREATE INDEX "story_narrator_looks_characterId_idx" ON "story_narrator_looks"("characterId");
ALTER TABLE "story_narrator_looks" ADD CONSTRAINT "story_narrator_looks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "story_narrator_looks" ADD CONSTRAINT "story_narrator_looks_manifestId_fkey" FOREIGN KEY ("manifestId") REFERENCES "brand_manifests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "story_narrator_looks" ADD CONSTRAINT "story_narrator_looks_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "brand_characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "brand_manifests"
  ADD COLUMN "narratorImageConsentAt" TIMESTAMP(3),
  ADD COLUMN "narratorImageConsentVersion" TEXT,
  ADD COLUMN "narratorImageConsentRevokedAt" TIMESTAMP(3),
  ADD COLUMN "narratorLookId" TEXT,
  ADD COLUMN "narratorLookAsset" TEXT,
  ADD CONSTRAINT "brand_narrator_image_consent" CHECK (("narratorImageConsentAt" IS NULL) = ("narratorImageConsentVersion" IS NULL)),
  ADD CONSTRAINT "brand_narrator_look_asset" CHECK ("narratorLookAsset" IS NULL OR "narratorLookAsset" IN ('photo','styled'));
ALTER TABLE "brand_manifests" ADD CONSTRAINT "brand_manifests_narratorLookId_fkey" FOREIGN KEY ("narratorLookId") REFERENCES "story_narrator_looks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "story_narrator_looks" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "story_narrator_looks" FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE "story_narrator_looks" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
