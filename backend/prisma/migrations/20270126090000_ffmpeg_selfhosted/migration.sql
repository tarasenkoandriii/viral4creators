-- FFmpeg-server v1.1 §11/§13.1: provider routing for NEW ffmpeg jobs (with the
-- selfhosted circuit breaker), fallback events and the append-only operator
-- journal of the admin "FFmpeg" tab. Already accepted
-- jobs are routed by their id prefix (`selfhosted:`), never by this table.

CREATE TABLE "ffmpeg_routing" (
  "id" TEXT NOT NULL DEFAULT 'default' PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "defaultProvider" TEXT NOT NULL DEFAULT 'selfhosted',
  "canaryProducts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy" TEXT,
  "breakerFailures" INTEGER NOT NULL DEFAULT 0,
  "breakerLastFailureAt" TIMESTAMP(3),
  "breakerOpenUntil" TIMESTAMP(3),
  "breakerProbeUntil" TIMESTAMP(3),
  "breakerProbeJobId" TEXT,
  CONSTRAINT "ffmpeg_routing_breaker" CHECK ("breakerFailures" >= 0),
  CONSTRAINT "ffmpeg_routing_singleton" CHECK ("id" = 'default'),
  CONSTRAINT "ffmpeg_routing_revision" CHECK ("revision" >= 1),
  CONSTRAINT "ffmpeg_routing_provider" CHECK ("defaultProvider" IN ('hosted', 'selfhosted')),
  CONSTRAINT "ffmpeg_routing_canary" CHECK (
    cardinality("canaryProducts") <= 16 AND
    "canaryProducts" <@ ARRAY[
      'postprod','actors','audio-track','portfolio','story','tutorial-runner',
      'tutorial-video-versions','shared-video','client-site-tutorial','tutorial-quality'
    ]::TEXT[]
  )
);
-- Owner decision 21.10.2026: selfhosted is the primary provider once the env
-- gate FFMPEG_SELFHOSTED_ENABLED is on (off by default: until then everything
-- stays on hosted), with fallback to hosted only on a proven refusal.
INSERT INTO "ffmpeg_routing" ("id") VALUES ('default') ON CONFLICT DO NOTHING;

CREATE TABLE "ffmpeg_fallback_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reason" TEXT NOT NULL,
  "code" TEXT,
  "product" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ffmpeg_fallback_reason" CHECK ("reason" IN ('refused', 'not-found', 'breaker-open')),
  CONSTRAINT "ffmpeg_fallback_code" CHECK ("code" IS NULL OR "code" ~ '^[A-Za-z0-9_.-]{1,64}$'),
  CONSTRAINT "ffmpeg_fallback_product" CHECK ("product" IS NULL OR char_length("product") <= 64)
);
CREATE INDEX "ffmpeg_fallback_events_createdAt_idx" ON "ffmpeg_fallback_events"("createdAt");

-- FF-INT-08: each failed job of our server counts against the breaker once.
CREATE TABLE "ffmpeg_breaker_jobs" (
  "jobId" TEXT NOT NULL PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ffmpeg_breaker_job" CHECK (char_length("jobId") BETWEEN 1 AND 160)
);
CREATE INDEX "ffmpeg_breaker_jobs_createdAt_idx" ON "ffmpeg_breaker_jobs"("createdAt");

-- FF-INT-02: provider and key are pinned to the operation BEFORE the network
-- call; a retry of an unconfirmed send to our server is reconciled there first.
CREATE TABLE "ffmpeg_submissions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "idempotencyKey" TEXT NOT NULL,
  "bodyHash" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "product" TEXT,
  "operationKey" TEXT,
  "provider" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "jobId" TEXT,
  "fallbackReason" TEXT,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ffmpeg_submission_key" CHECK ("idempotencyKey" ~ '^[!-~]{1,128}$'),
  CONSTRAINT "ffmpeg_submission_body" CHECK ("bodyHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ffmpeg_submission_attempt" CHECK ("attempt" BETWEEN 0 AND 1000),
  CONSTRAINT "ffmpeg_submission_provider" CHECK ("provider" IN ('hosted', 'selfhosted')),
  CONSTRAINT "ffmpeg_submission_state" CHECK ("state" IN ('sending', 'accepted', 'refused', 'unknown')),
  CONSTRAINT "ffmpeg_submission_job" CHECK ("jobId" IS NULL OR char_length("jobId") <= 160),
  CONSTRAINT "ffmpeg_submission_accepted" CHECK ("state" <> 'accepted' OR "jobId" IS NOT NULL),
  CONSTRAINT "ffmpeg_submission_fallback" CHECK ("fallbackReason" IS NULL OR "fallbackReason" IN ('refused', 'not-found', 'breaker-open')),
  CONSTRAINT "ffmpeg_submission_product" CHECK ("product" IS NULL OR char_length("product") <= 64)
);
CREATE UNIQUE INDEX "ffmpeg_submissions_idempotencyKey_key" ON "ffmpeg_submissions"("idempotencyKey");
CREATE INDEX "ffmpeg_submissions_createdAt_idx" ON "ffmpeg_submissions"("createdAt");

CREATE TABLE "ffmpeg_operator_actions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "operationId" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "jobId" TEXT,
  "clientOperationId" TEXT,
  "reason" TEXT,
  "oldRevision" INTEGER,
  "newRevision" INTEGER,
  "result" JSONB,
  "correlationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ffmpeg_operator_phase" CHECK ("phase" IN ('requested', 'succeeded', 'failed', 'unknown')),
  CONSTRAINT "ffmpeg_operator_action" CHECK ("action" IN (
    'pause', 'drain', 'resume',
    'job.cancel', 'job.purge', 'job.reconcile', 'job.download-link',
    'limits.update', 'routing.update'
  )),
  CONSTRAINT "ffmpeg_operator_operation" CHECK (
    "operationId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "ffmpeg_operator_reason" CHECK ("reason" IS NULL OR char_length("reason") <= 500),
  CONSTRAINT "ffmpeg_operator_job" CHECK ("jobId" IS NULL OR char_length("jobId") <= 160),
  CONSTRAINT "ffmpeg_operator_client_op" CHECK ("clientOperationId" IS NULL OR char_length("clientOperationId") <= 128),
  CONSTRAINT "ffmpeg_operator_correlation" CHECK (char_length("correlationId") BETWEEN 1 AND 128)
);
CREATE UNIQUE INDEX "ffmpeg_operator_actions_operationId_phase_key"
  ON "ffmpeg_operator_actions"("operationId", "phase");
CREATE INDEX "ffmpeg_operator_actions_createdAt_idx" ON "ffmpeg_operator_actions"("createdAt");
CREATE INDEX "ffmpeg_operator_actions_jobId_createdAt_idx" ON "ffmpeg_operator_actions"("jobId", "createdAt");

-- Entries are never rewritten. DELETE stays possible: 90-day retention (cron
-- cleanup-sessions) and lawful erasure.
CREATE FUNCTION ffmpeg_operator_actions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ffmpeg_operator_actions is append-only' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER ffmpeg_operator_actions_append_only BEFORE UPDATE ON "ffmpeg_operator_actions"
FOR EACH ROW EXECUTE FUNCTION ffmpeg_operator_actions_append_only();
REVOKE ALL ON FUNCTION ffmpeg_operator_actions_append_only() FROM PUBLIC;

-- Owner lookup of a job on the admin "FFmpeg" card (no full scan on refresh).
CREATE INDEX "tutorial_video_assets_assemblyJobId_idx" ON "tutorial_video_assets"("assemblyJobId");
CREATE INDEX "tutorial_video_versions_jobId_idx" ON "tutorial_video_versions"("jobId");
CREATE INDEX "tutorial_demo_quality_checks_signalsJobId_idx" ON "tutorial_demo_quality_checks"("signalsJobId");
CREATE INDEX "portfolio_items_watermarkJobId_idx" ON "portfolio_items"("watermarkJobId");
CREATE INDEX "video_audio_tracks_mixJobId_idx" ON "video_audio_tracks"("mixJobId");

ALTER TABLE "ffmpeg_routing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ffmpeg_operator_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ffmpeg_fallback_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ffmpeg_breaker_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ffmpeg_submissions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "ffmpeg_routing" FROM PUBLIC;
REVOKE ALL ON TABLE "ffmpeg_operator_actions" FROM PUBLIC;
REVOKE ALL ON TABLE "ffmpeg_fallback_events" FROM PUBLIC;
REVOKE ALL ON TABLE "ffmpeg_breaker_jobs" FROM PUBLIC;
REVOKE ALL ON TABLE "ffmpeg_submissions" FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE "ffmpeg_routing" FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TABLE "ffmpeg_operator_actions" FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TABLE "ffmpeg_fallback_events" FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TABLE "ffmpeg_breaker_jobs" FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TABLE "ffmpeg_submissions" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
