ALTER TABLE "qa_test_runs" ADD COLUMN "automationProject" TEXT;
ALTER TABLE "qa_test_run_attempts"
 ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual',
 ADD COLUMN "project" TEXT,
 ADD COLUMN "sourceAttempt" INTEGER,
 ADD COLUMN "reportHash" TEXT,
 ADD COLUMN "durationMs" DOUBLE PRECISION,
 ADD COLUMN "sourceMetadata" JSONB;
CREATE UNIQUE INDEX "qa_test_run_attempts_runId_reportHash_caseKey_sourceAttempt_key" ON "qa_test_run_attempts"("runId", "reportHash", "caseKey", "sourceAttempt");
ALTER TABLE "qa_test_run_attempts" ADD CONSTRAINT "qa_attempt_origin" CHECK (
 ("origin" = 'manual' AND "project" IS NULL AND "sourceAttempt" IS NULL AND "reportHash" IS NULL AND "durationMs" IS NULL AND "sourceMetadata" IS NULL)
 OR ("origin" = 'automated' AND "project" IS NOT NULL AND "sourceAttempt" IS NOT NULL AND "sourceAttempt" >= 0 AND "reportHash" IS NOT NULL AND "reportHash" ~ '^[a-f0-9]{64}$' AND "durationMs" IS NOT NULL AND "durationMs" >= 0 AND "sourceMetadata" IS NOT NULL)
);
