-- WP1 Story-Tales: append-only journal of operator reconciliation of UNKNOWN
-- results and of retention purges. Holds no story text, audio, video or photo.
CREATE TABLE "story_operator_actions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestId" TEXT UNIQUE,
  "actorKind" TEXT NOT NULL,
  "actorUserId" TEXT,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "previousState" JSONB NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_operator_actor" CHECK (
    ("actorKind" = 'admin' AND "actorUserId" IS NOT NULL AND "requestId" IS NOT NULL) OR
    ("actorKind" = 'cron' AND "actorUserId" IS NULL)
  ),
  CONSTRAINT "story_operator_target" CHECK ("targetType" IN ('gift','render','reference','segment')),
  CONSTRAINT "story_operator_action" CHECK ("action" IN (
    'gift.close-failed','gift.reopen-draft','gift.qa-reset',
    'render.bind-job','render.close-failed','render.qa-reset',
    'reference.close-unavailable','reference.delete',
    'segment.close-deleted',
    'retention.purge'
  )),
  CONSTRAINT "story_operator_reason" CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
  CONSTRAINT "story_operator_request" CHECK (
    "requestId" IS NULL OR "requestId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
);
CREATE INDEX "story_operator_actions_targetType_targetId_createdAt_idx"
  ON "story_operator_actions"("targetType", "targetId", "createdAt");
CREATE INDEX "story_operator_actions_createdAt_idx" ON "story_operator_actions"("createdAt");

-- The journal is evidence: entries are never rewritten, including by writers
-- outside the application. DELETE stays possible for a lawful erasure request.
CREATE FUNCTION story_operator_actions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'story_operator_actions is append-only' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER story_operator_actions_append_only BEFORE UPDATE ON "story_operator_actions"
FOR EACH ROW EXECUTE FUNCTION story_operator_actions_append_only();
REVOKE ALL ON FUNCTION story_operator_actions_append_only() FROM PUBLIC;

ALTER TABLE "story_operator_actions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "story_operator_actions" FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE "story_operator_actions" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
