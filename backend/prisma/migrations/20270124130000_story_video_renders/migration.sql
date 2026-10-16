CREATE TABLE "story_video_renders" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "giftId" TEXT NOT NULL REFERENCES "story_gifts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "configHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PREPARING',
  "preambleText" TEXT NOT NULL,
  "qaStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "qa" JSONB,
  "preambleAudio" BYTEA,
  "preambleDuration" DOUBLE PRECISION,
  "baseRevision" TEXT NOT NULL,
  "baseHash" TEXT NOT NULL,
  "mainAudioHash" TEXT NOT NULL,
  "voiceId" TEXT NOT NULL,
  "reservedMicroUsd" INTEGER NOT NULL,
  "assetTokenHash" TEXT UNIQUE,
  "assetExpiresAt" TIMESTAMP(3),
  "jobId" TEXT,
  "video" BYTEA,
  "videoHash" TEXT,
  "durationSeconds" DOUBLE PRECISION,
  "approvedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_render_preamble_limit" CHECK (octet_length("preambleAudio") <= 1048576),
  CONSTRAINT "story_render_video_limit" CHECK (octet_length("video") <= 3145728),
  CONSTRAINT "story_render_state" CHECK ("status" IN ('PREPARING','PENDING','READY','FAILED','UNKNOWN','DELETED')),
  CONSTRAINT "story_render_budget" CHECK ("reservedMicroUsd" >= 0)
);
CREATE UNIQUE INDEX "story_video_renders_giftId_configHash_key" ON "story_video_renders"("giftId", "configHash");
CREATE INDEX "story_video_renders_giftId_createdAt_idx" ON "story_video_renders"("giftId", "createdAt");
ALTER TABLE "story_video_renders" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "story_video_renders" FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE "story_video_renders" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
