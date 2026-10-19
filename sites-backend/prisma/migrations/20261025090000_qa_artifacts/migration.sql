CREATE TABLE "qa_artifacts" (
 "id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "siteId" TEXT NOT NULL,
 "findingId" TEXT NOT NULL, "findingRevision" INTEGER NOT NULL CHECK ("findingRevision" > 0), "requestId" TEXT NOT NULL, "pathname" TEXT NOT NULL,
 "sha256" TEXT NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
 "bytes" INTEGER NOT NULL CHECK ("bytes" > 0 AND "bytes" <= 2097152),
 "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending','ready')),
 "expiresAt" TIMESTAMP(3) NOT NULL, "createdByMemberId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "qa_artifacts_siteId_accountId_fkey" FOREIGN KEY ("siteId","accountId") REFERENCES "site_sites"("id","accountId") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "qa_artifacts_findingId_accountId_fkey" FOREIGN KEY ("findingId","accountId") REFERENCES "qa_findings"("id","accountId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "qa_artifacts_findingId_findingRevision_fkey" FOREIGN KEY ("findingId","findingRevision") REFERENCES "qa_finding_revisions"("findingId","version") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "qa_artifacts_pathname_key" ON "qa_artifacts"("pathname");
CREATE UNIQUE INDEX "qa_artifacts_siteId_requestId_key" ON "qa_artifacts"("siteId","requestId");
CREATE INDEX "qa_artifacts_accountId_siteId_findingId_createdAt_idx" ON "qa_artifacts"("accountId","siteId","findingId","createdAt");
CREATE INDEX "qa_artifacts_expiresAt_idx" ON "qa_artifacts"("expiresAt");
REVOKE ALL ON "qa_artifacts" FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='assist_public') THEN REVOKE ALL ON "qa_artifacts" FROM assist_public; END IF; END $$;
