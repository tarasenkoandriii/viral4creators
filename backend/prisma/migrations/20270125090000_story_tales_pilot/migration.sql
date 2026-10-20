-- Story-Tales pass 3 (Р-ST3-1..3): invite-only paid pilot, Story rules
-- acceptance with 18+, credits for paid steps and 90-day public links.

-- Р-ST3-3: a public link lives 90 days (ТЗ §11.4). Links issued before the
-- development lockdown never come back: every old hash is dropped.
ALTER TABLE "story_gifts" ADD COLUMN "sharedAt" TIMESTAMP(3);
ALTER TABLE "story_gifts" ADD COLUMN "shareExpiresAt" TIMESTAMP(3);
-- ТЗ §11.1: a release with a non-Nova narrator (voice clone, own recorded
-- intro, narrator image) is published only with the narrator's consent to
-- distribution by link; the fact and the rules version live with the link.
ALTER TABLE "story_gifts" ADD COLUMN "narratorPublicConsentAt" TIMESTAMP(3);
ALTER TABLE "story_gifts" ADD COLUMN "narratorPublicConsentVersion" TEXT;
-- ST3-S-04: the consent covers exactly one approved render (the release).
ALTER TABLE "story_gifts" ADD COLUMN "narratorPublicConsentRenderId" TEXT;
UPDATE "story_gifts" SET "shareHash" = NULL WHERE "shareHash" IS NOT NULL;
ALTER TABLE "story_gifts" ADD CONSTRAINT "story_gift_share_window" CHECK (
  ("shareHash" IS NULL AND "sharedAt" IS NULL AND "shareExpiresAt" IS NULL) OR
  ("shareHash" IS NOT NULL AND "sharedAt" IS NOT NULL AND "shareExpiresAt" > "sharedAt"
    AND "shareExpiresAt" <= "sharedAt" + INTERVAL '90 days')
);
ALTER TABLE "story_gifts" ADD CONSTRAINT "story_gift_narrator_public_consent" CHECK (
  ("narratorPublicConsentAt" IS NULL AND "narratorPublicConsentVersion" IS NULL
    AND "narratorPublicConsentRenderId" IS NULL) OR
  ("narratorPublicConsentAt" IS NOT NULL AND "shareHash" IS NOT NULL
    AND "narratorPublicConsentRenderId" IS NOT NULL
    AND "narratorPublicConsentVersion" IS NOT NULL
    AND "narratorPublicConsentVersion" ~ '^[a-z0-9][a-z0-9.-]{0,63}$')
);

-- ST3: consent texts are shown in the request language (ru/uk/en); the
-- language of the text the adult confirmed is kept with the consent.
ALTER TABLE "story_video_renders" ADD COLUMN "voiceConsentLocale" TEXT;
ALTER TABLE "story_video_renders" ADD CONSTRAINT "story_render_consent_locale"
  CHECK ("voiceConsentLocale" IS NULL OR "voiceConsentLocale" IN ('ru','uk','en'));
ALTER TABLE "story_video_segments" ADD COLUMN "consentLocale" TEXT;
ALTER TABLE "story_video_segments" ADD CONSTRAINT "story_segment_consent_locale"
  CHECK ("consentLocale" IS NULL OR "consentLocale" IN ('ru','uk','en'));

-- Р-ST3-1/7: applications from the TMA (one per user) and participants.
CREATE TABLE "story_pilot_applications" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scenario" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_pilot_applications_pkey" PRIMARY KEY ("id"),
  -- expired: pending older than 90 days (retention, text erased).
  CONSTRAINT "story_pilot_application_status" CHECK ("status" IN ('pending','approved','rejected','expired')),
  CONSTRAINT "story_pilot_application_decided" CHECK (("status" = 'pending') = ("decidedAt" IS NULL)),
  CONSTRAINT "story_pilot_application_scenario" CHECK ("scenario" IS NULL OR char_length("scenario") BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX "story_pilot_applications_userId_key" ON "story_pilot_applications"("userId");
CREATE INDEX "story_pilot_applications_status_createdAt_idx" ON "story_pilot_applications"("status", "createdAt");
ALTER TABLE "story_pilot_applications" ADD CONSTRAINT "story_pilot_applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "story_pilot_members" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "applicationId" TEXT,
  "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "freeGiftUsedAt" TIMESTAMP(3),
  "freeGiftId" TEXT,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_pilot_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "story_pilot_member_free_gift" CHECK (("freeGiftUsedAt" IS NULL) = ("freeGiftId" IS NULL)),
  CONSTRAINT "story_pilot_member_revoked" CHECK ("revokedAt" IS NULL OR "revokedAt" >= "since")
);
CREATE UNIQUE INDEX "story_pilot_members_userId_key" ON "story_pilot_members"("userId");
CREATE UNIQUE INDEX "story_pilot_members_applicationId_key" ON "story_pilot_members"("applicationId");
CREATE INDEX "story_pilot_members_revokedAt_idx" ON "story_pilot_members"("revokedAt");
ALTER TABLE "story_pilot_members" ADD CONSTRAINT "story_pilot_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Story rules (versioned) + 18+: required for a member or user before any build.
CREATE TABLE "story_terms_acceptances" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "termsVersion" TEXT NOT NULL,
  "adult" BOOLEAN NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_terms_acceptances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "story_terms_adult" CHECK ("adult" = true),
  CONSTRAINT "story_terms_version" CHECK ("termsVersion" ~ '^[a-z0-9][a-z0-9.-]{0,63}$')
);
CREATE UNIQUE INDEX "story_terms_acceptances_userId_termsVersion_key" ON "story_terms_acceptances"("userId", "termsVersion");
ALTER TABLE "story_terms_acceptances" ADD CONSTRAINT "story_terms_acceptances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Р-ST3-2: credits reserved for one paid step (audio render, video export).
CREATE TABLE "story_credit_charges" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "giftId" TEXT NOT NULL,
  "renderId" TEXT,
  "credits" INTEGER NOT NULL,
  "reserveMicroUsd" INTEGER NOT NULL,
  "priceMicroUsd" INTEGER NOT NULL,
  "free" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'RESERVED',
  "refundedAt" TIMESTAMP(3),
  "capturedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_credit_charges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "story_charge_kind" CHECK (
    -- ST3-R-05: one key per audio attempt (`audio:<giftId>:<n>`): after a refund
    -- the same gift may be voiced again with a new charge.
    ("kind" = 'audio' AND "renderId" IS NULL AND "key" ~ ('^audio:' || "giftId" || ':[1-9][0-9]{0,2}$')) OR
    ("kind" = 'video' AND "renderId" IS NOT NULL AND "key" = 'video:' || "renderId")
  ),
  CONSTRAINT "story_charge_amount" CHECK (
    "credits" >= 0 AND "reserveMicroUsd" >= 0 AND "priceMicroUsd" >= 0 AND
    (NOT "free" OR ("credits" = 0 AND "priceMicroUsd" = 0))
  ),
  -- ST3-S-14: CAPTURED — the step was delivered (paid, never refunded).
  CONSTRAINT "story_charge_status" CHECK (
    ("status" = 'RESERVED' AND "refundedAt" IS NULL AND "capturedAt" IS NULL) OR
    ("status" = 'CAPTURED' AND "refundedAt" IS NULL AND "capturedAt" IS NOT NULL) OR
    ("status" = 'REFUNDED' AND "refundedAt" IS NOT NULL AND "capturedAt" IS NULL)
  )
);
CREATE UNIQUE INDEX "story_credit_charges_key_key" ON "story_credit_charges"("key");
CREATE INDEX "story_credit_charges_userId_createdAt_idx" ON "story_credit_charges"("userId", "createdAt");
CREATE INDEX "story_credit_charges_giftId_idx" ON "story_credit_charges"("giftId");
-- ST3-S-14: the auto-refund looks only at old RESERVED rows.
CREATE INDEX "story_credit_charges_status_createdAt_idx" ON "story_credit_charges"("status", "createdAt");
ALTER TABLE "story_credit_charges" ADD CONSTRAINT "story_credit_charges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "story_pilot_applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "story_pilot_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "story_terms_acceptances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "story_credit_charges" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "story_pilot_applications" FROM PUBLIC;
REVOKE ALL ON TABLE "story_pilot_members" FROM PUBLIC;
REVOKE ALL ON TABLE "story_terms_acceptances" FROM PUBLIC;
REVOKE ALL ON TABLE "story_credit_charges" FROM PUBLIC;
DO $$
DECLARE role_name TEXT; table_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      FOREACH table_name IN ARRAY ARRAY['story_pilot_applications', 'story_pilot_members', 'story_terms_acceptances', 'story_credit_charges'] LOOP
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', table_name, role_name);
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- Pilot administration is journaled like reconciliation (append-only).
ALTER TABLE "story_operator_actions" DROP CONSTRAINT "story_operator_target";
ALTER TABLE "story_operator_actions" ADD CONSTRAINT "story_operator_target" CHECK (
  "targetType" IN ('gift','render','reference','segment','pilot-application','pilot-member','voice-sample')
);
ALTER TABLE "story_operator_actions" DROP CONSTRAINT "story_operator_action";
ALTER TABLE "story_operator_actions" ADD CONSTRAINT "story_operator_action" CHECK ("action" IN (
  'gift.close-failed','gift.reopen-draft','gift.qa-reset',
  'render.bind-job','render.close-failed','render.qa-reset',
  'reference.close-unavailable','reference.delete',
  'segment.close-deleted',
  'retention.purge',
  'owner.recording-delete',
  'pilot.approve','pilot.reject','pilot.revoke',
  'charge.auto-refund'
));
-- ST3-S-02: credits of an unfinished step go back automatically (owner's
-- deletion, or 14 days in UNKNOWN without an operator decision).
ALTER TABLE "story_operator_actions" ADD CONSTRAINT "story_operator_auto_refund" CHECK (
  "action" <> 'charge.auto-refund' OR
  ("actorKind" IN ('cron','owner') AND "targetType" IN ('gift','render'))
);
-- Pilot actions are admin-only and target only pilot rows; the cron may only
-- erase a decided application's text (90 days) and a READY clone's source
-- recording (7 days, ТЗ §11.4). The journal itself is deleted after a year.
ALTER TABLE "story_operator_actions" ADD CONSTRAINT "story_operator_pilot_scope" CHECK (
  ("action" NOT LIKE 'pilot.%' OR ("actorKind" = 'admin' AND "targetType" IN ('pilot-application','pilot-member')))
  AND ("targetType" NOT IN ('pilot-application','pilot-member') OR "action" LIKE 'pilot.%'
       OR ("action" = 'retention.purge' AND "actorKind" = 'cron' AND "targetType" = 'pilot-application'))
  AND ("targetType" <> 'voice-sample' OR ("action" = 'retention.purge' AND "actorKind" = 'cron'))
);

-- ST3-S-14 data fix: RESERVED charges of steps already delivered become
-- CAPTURED (no rows on a fresh apply; the story-finalize cron runs the same
-- sweep, `StoryChargesService.captureDelivered`).
UPDATE "story_credit_charges" c
   SET "status" = 'CAPTURED', "capturedAt" = now()
 WHERE c."status" = 'RESERVED' AND (
   (c."kind" = 'audio' AND EXISTS (SELECT 1 FROM "story_gifts" g
      WHERE g."id" = c."giftId" AND g."status" IN ('READY','APPROVED')))
   OR (c."kind" = 'video' AND EXISTS (SELECT 1 FROM "story_video_renders" r
      WHERE r."id" = c."renderId" AND r."status" = 'READY')));
