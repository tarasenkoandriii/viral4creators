ALTER TABLE "story_video_renders"
  ADD COLUMN "mainAudio" BYTEA,
  ADD COLUMN "mainDuration" DOUBLE PRECISION,
  ADD COLUMN "parentNarrationKey" TEXT,
  ADD COLUMN "narratorManifestId" TEXT,
  ADD COLUMN "userVoiceId" TEXT,
  ADD COLUMN "voiceLabel" TEXT,
  ADD COLUMN "voiceConsentAt" TIMESTAMP(3),
  ADD COLUMN "voiceConsentVersion" TEXT,
  ADD CONSTRAINT "story_render_main_audio_limit" CHECK (octet_length("mainAudio") <= 2097152),
  ADD CONSTRAINT "story_render_parent_consent" CHECK ("userVoiceId" IS NULL OR ("voiceConsentAt" IS NOT NULL AND "voiceConsentVersion" IS NOT NULL AND "narratorManifestId" IS NOT NULL));
CREATE INDEX "story_video_renders_parentNarrationKey_idx" ON "story_video_renders"("parentNarrationKey");
