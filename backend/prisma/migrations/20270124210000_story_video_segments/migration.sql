-- WP4 Story-Tales: segment manifest of a video render and a private per-gift
-- speech segment cache (ST-P2) incl. the adult's own recorded preamble (ST-P1).
ALTER TABLE "story_video_renders" ADD COLUMN "segments" JSONB;

CREATE TABLE "story_video_segments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "giftId" TEXT NOT NULL REFERENCES "story_gifts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "cacheKey" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "text" TEXT NOT NULL DEFAULT '',
  "voiceId" TEXT,
  "userVoiceId" TEXT,
  "mime" TEXT NOT NULL DEFAULT 'audio/mpeg',
  "audio" BYTEA,
  "audioHash" TEXT,
  "durationSeconds" DOUBLE PRECISION,
  "consentVersion" TEXT,
  "consentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_segment_state" CHECK ("status" IN ('PENDING','READY','UNKNOWN','DELETED')),
  CONSTRAINT "story_segment_source" CHECK ("source" IN ('synth','recorded')),
  CONSTRAINT "story_segment_mime" CHECK ("mime" IN ('audio/mpeg','audio/wav')),
  CONSTRAINT "story_segment_audio_limit" CHECK (octet_length("audio") <= 1048576),
  CONSTRAINT "story_segment_key" CHECK ("cacheKey" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "story_segment_text_limit" CHECK (char_length("text") <= 400),
  CONSTRAINT "story_segment_ready" CHECK (
    "status" <> 'READY' OR ("audio" IS NOT NULL AND "audioHash" IS NOT NULL AND "durationSeconds" IS NOT NULL)
  ),
  CONSTRAINT "story_segment_synth" CHECK ("source" <> 'synth' OR "voiceId" IS NOT NULL),
  CONSTRAINT "story_segment_recorded_consent" CHECK (
    "source" <> 'recorded' OR ("consentVersion" IS NOT NULL AND "consentAt" IS NOT NULL AND "mime" = 'audio/wav')
  )
);
CREATE UNIQUE INDEX "story_video_segments_giftId_cacheKey_key" ON "story_video_segments"("giftId", "cacheKey");
CREATE INDEX "story_video_segments_status_updatedAt_idx" ON "story_video_segments"("status", "updatedAt");
-- F1 (A-S2-3): retention erases speech synthesized by a deleted voice.
CREATE INDEX "story_video_segments_userVoiceId_idx" ON "story_video_segments"("userVoiceId");
-- F1 (A-S3-8): a provider job id is bound to at most one render (NULLs stay
-- allowed: PostgreSQL unique indexes treat NULLs as distinct).
CREATE UNIQUE INDEX "story_video_renders_jobId_key" ON "story_video_renders"("jobId");

ALTER TABLE "story_video_segments" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "story_video_segments" FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE "story_video_segments" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
