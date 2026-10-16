CREATE TABLE "story_gifts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "catalogId" TEXT NOT NULL,
  "occasion" TEXT,
  "giftNote" TEXT,
  "giftNotePosition" TEXT,
  "title" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "chapters" JSONB NOT NULL,
  "textHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "voiceId" TEXT NOT NULL,
  "audio" BYTEA,
  "giftPhoto" BYTEA,
  "hasGiftPhoto" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "story_photo_limit" CHECK (octet_length("giftPhoto") <= 1048576),
  "audioMime" TEXT,
  "durationSeconds" DOUBLE PRECISION,
  "audioHash" TEXT,
  "error" TEXT,
  "approvedAt" TIMESTAMP(3),
  "shareHash" TEXT UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_audio_limit" CHECK (octet_length("audio") <= 3145728),
  CONSTRAINT "story_state" CHECK ("status" IN ('DRAFT','SYNTHESIZING','READY','APPROVED','UNKNOWN','FAILED','DELETED'))
);
CREATE INDEX "story_gifts_userId_createdAt_idx" ON "story_gifts"("userId", "createdAt");
ALTER TABLE "story_gifts" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "story_gifts" FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE "story_gifts" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
