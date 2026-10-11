CREATE TABLE "qa_findings" (
 "id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "siteId" TEXT NOT NULL,
 "fingerprint" TEXT NOT NULL, "title" TEXT NOT NULL, "status" TEXT NOT NULL, "severity" TEXT NOT NULL,
 "revision" INTEGER NOT NULL DEFAULT 1, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "qa_finding_status" CHECK ("status" IN ('needs_confirmation','confirmed','not_reproduced','accepted_risk','fixed_verified')),
 CONSTRAINT "qa_finding_severity" CHECK ("severity" IN ('P0','P1','P2','P3')),
 CONSTRAINT "qa_finding_revision_positive" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "qa_findings_id_accountId_key" ON "qa_findings"("id","accountId");
CREATE UNIQUE INDEX "qa_findings_siteId_fingerprint_key" ON "qa_findings"("siteId","fingerprint");
CREATE INDEX "qa_findings_accountId_siteId_id_idx" ON "qa_findings"("accountId","siteId","id");
ALTER TABLE "qa_findings" ADD CONSTRAINT "qa_findings_siteId_accountId_fkey" FOREIGN KEY ("siteId","accountId") REFERENCES "site_sites"("id","accountId") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "qa_finding_revisions" (
 "id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "findingId" TEXT NOT NULL,
 "version" INTEGER NOT NULL CHECK ("version" > 0), "payload" JSONB NOT NULL,
 "createdByMemberId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "qa_finding_revisions_findingId_version_key" ON "qa_finding_revisions"("findingId","version");
CREATE INDEX "qa_finding_revisions_accountId_findingId_id_idx" ON "qa_finding_revisions"("accountId","findingId","id");
ALTER TABLE "qa_finding_revisions" ADD CONSTRAINT "qa_finding_revisions_findingId_accountId_fkey" FOREIGN KEY ("findingId","accountId") REFERENCES "qa_findings"("id","accountId") ON DELETE CASCADE ON UPDATE CASCADE;
REVOKE ALL ON "qa_findings", "qa_finding_revisions" FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assist_public') THEN
  REVOKE ALL ON "qa_findings", "qa_finding_revisions" FROM assist_public;
 END IF;
END $$;
