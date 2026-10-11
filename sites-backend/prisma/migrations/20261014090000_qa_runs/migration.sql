-- CreateTable
CREATE TABLE "qa_test_runs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdByMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qa_test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qa_test_run_attempts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "caseKey" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "comment" TEXT NOT NULL,
    "createdByMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qa_test_run_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "qa_test_runs_accountId_siteId_id_idx" ON "qa_test_runs"("accountId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "qa_test_runs_id_accountId_key" ON "qa_test_runs"("id", "accountId");

-- CreateIndex
CREATE INDEX "qa_test_run_attempts_accountId_runId_id_idx" ON "qa_test_run_attempts"("accountId", "runId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "qa_test_run_attempts_runId_caseKey_attemptNumber_key" ON "qa_test_run_attempts"("runId", "caseKey", "attemptNumber");

-- AddForeignKey
ALTER TABLE "qa_test_runs" ADD CONSTRAINT "qa_test_runs_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_test_run_attempts" ADD CONSTRAINT "qa_test_run_attempts_runId_accountId_fkey" FOREIGN KEY ("runId", "accountId") REFERENCES "qa_test_runs"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;


REVOKE ALL ON "qa_test_runs", "qa_test_run_attempts" FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assist_public') THEN
  REVOKE ALL ON "qa_test_runs", "qa_test_run_attempts" FROM assist_public;
 END IF;
END $$;
ALTER TABLE "qa_test_run_attempts" ADD CONSTRAINT "qa_run_attempt_status" CHECK ("status" IN ('passed','failed','blocked','skipped'));
ALTER TABLE "qa_test_run_attempts" ADD CONSTRAINT "qa_run_attempt_positive" CHECK ("attemptNumber" > 0);
