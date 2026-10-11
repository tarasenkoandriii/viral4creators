-- CreateTable
CREATE TABLE "qa_test_cases" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "caseKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qa_test_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qa_test_case_revisions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdByMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qa_test_case_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "qa_test_cases_accountId_siteId_updatedAt_idx" ON "qa_test_cases"("accountId", "siteId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "qa_test_cases_id_accountId_key" ON "qa_test_cases"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "qa_test_cases_siteId_caseKey_key" ON "qa_test_cases"("siteId", "caseKey");

-- CreateIndex
CREATE INDEX "qa_test_case_revisions_accountId_caseId_idx" ON "qa_test_case_revisions"("accountId", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "qa_test_case_revisions_caseId_version_key" ON "qa_test_case_revisions"("caseId", "version");

-- AddForeignKey
ALTER TABLE "qa_test_cases" ADD CONSTRAINT "qa_test_cases_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_test_case_revisions" ADD CONSTRAINT "qa_test_case_revisions_caseId_accountId_fkey" FOREIGN KEY ("caseId", "accountId") REFERENCES "qa_test_cases"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;


-- QA records are private cabinet data, inaccessible to the public widget role.
REVOKE ALL ON "qa_test_cases", "qa_test_case_revisions" FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assist_public') THEN
  REVOKE ALL ON "qa_test_cases", "qa_test_case_revisions" FROM assist_public;
 END IF;
END $$;
