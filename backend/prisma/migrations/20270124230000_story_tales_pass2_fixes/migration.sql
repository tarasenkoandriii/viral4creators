-- Story-Tales pass 2 (ST2-S-01, ST2-S-02, ST2-S-04, ST2-S-09).

-- ST2-S-01: speech this render synthesized and saved (confirmed). An operator
-- close with releaseReserve keeps exactly its TTS reserve (like FAILED before
-- submit), releasing only the assembly/QA part and unconfirmed stages.
ALTER TABLE "story_video_renders" ADD COLUMN "paidSpeechChars" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "story_video_renders" ADD CONSTRAINT "story_render_paid_speech" CHECK ("paidSpeechChars" >= 0);

-- ST2-S-02: narrator-look image-call ledger. The quota no longer counts
-- story_narrator_looks rows (they cascade with the brand manifest/character),
-- but these rows: no FK to the look/manifest/character, only to the account.
CREATE TABLE "story_narrator_look_calls" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "lookId" TEXT NOT NULL,
  "imageCalls" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_narrator_look_calls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "story_narrator_look_call_count" CHECK ("imageCalls" BETWEEN 0 AND 2)
);
CREATE UNIQUE INDEX "story_narrator_look_calls_lookId_key" ON "story_narrator_look_calls"("lookId");
CREATE INDEX "story_narrator_look_calls_userId_createdAt_idx" ON "story_narrator_look_calls"("userId", "createdAt");
ALTER TABLE "story_narrator_look_calls" ADD CONSTRAINT "story_narrator_look_calls_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ST2-S-04: a look whose consent was revoked right before the model call
-- records 0 started calls (previously the minimum was 1).
ALTER TABLE "story_narrator_looks" DROP CONSTRAINT "story_narrator_look_calls";
ALTER TABLE "story_narrator_looks" ADD CONSTRAINT "story_narrator_look_calls" CHECK ("imageCalls" BETWEEN 0 AND 2 AND "reservedMicroUsd" >= 0);

-- Existing looks keep counting (backfill with their own id and creation time).
INSERT INTO "story_narrator_look_calls" ("id", "userId", "lookId", "imageCalls", "createdAt")
SELECT gen_random_uuid()::text, "userId", "id", "imageCalls", "createdAt" FROM "story_narrator_looks"
ON CONFLICT ("lookId") DO NOTHING;

ALTER TABLE "story_narrator_look_calls" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "story_narrator_look_calls" FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE "story_narrator_look_calls" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

-- ST2-S-09 follow-up: the owner's deletion of their recorded preamble erases
-- the text of UNKNOWN speech segments of the renders it wipes, journaled as
-- actor 'owner' (no user id: the journal never holds the owner). Existing
-- rows are untouched (append-only).
ALTER TABLE "story_operator_actions" DROP CONSTRAINT "story_operator_actor";
ALTER TABLE "story_operator_actions" ADD CONSTRAINT "story_operator_actor" CHECK (
  ("actorKind" = 'admin' AND "actorUserId" IS NOT NULL AND "requestId" IS NOT NULL) OR
  ("actorKind" IN ('cron', 'owner') AND "actorUserId" IS NULL)
);
ALTER TABLE "story_operator_actions" DROP CONSTRAINT "story_operator_action";
ALTER TABLE "story_operator_actions" ADD CONSTRAINT "story_operator_action" CHECK ("action" IN (
  'gift.close-failed','gift.reopen-draft','gift.qa-reset',
  'render.bind-job','render.close-failed','render.qa-reset',
  'reference.close-unavailable','reference.delete',
  'segment.close-deleted',
  'retention.purge',
  'owner.recording-delete'
));
