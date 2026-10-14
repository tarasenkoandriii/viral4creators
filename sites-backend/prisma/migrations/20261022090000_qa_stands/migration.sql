CREATE TABLE "qa_stands" (
 "id" TEXT PRIMARY KEY, "requestId" TEXT NOT NULL, "accountId" TEXT NOT NULL, "siteId" TEXT NOT NULL,
 "contract" JSONB NOT NULL, "records" JSONB NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "qa_stands_site_fk" FOREIGN KEY ("siteId","accountId") REFERENCES "site_sites"("id","accountId") ON DELETE CASCADE
);
CREATE INDEX "qa_stands_accountId_siteId_createdAt_idx" ON "qa_stands"("accountId","siteId","createdAt");
REVOKE ALL ON "qa_stands" FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assist_public') THEN REVOKE ALL ON "qa_stands" FROM assist_public; END IF;
END $$;

CREATE UNIQUE INDEX "qa_stands_accountId_siteId_requestId_key" ON "qa_stands"("accountId","siteId","requestId");
