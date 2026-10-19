ALTER TABLE "qa_test_runs" ADD COLUMN "context" JSONB;
CREATE TABLE "qa_plans" (
 "id" TEXT NOT NULL PRIMARY KEY,"accountId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"planKey" TEXT NOT NULL,"title" TEXT NOT NULL,
 "currentVersion" INTEGER NOT NULL DEFAULT 1 CHECK ("currentVersion">0),"archived" BOOLEAN NOT NULL DEFAULT FALSE,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "qa_plans_siteId_accountId_fkey" FOREIGN KEY ("siteId","accountId") REFERENCES "site_sites"("id","accountId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "qa_plans_id_accountId_key" ON "qa_plans"("id","accountId");
CREATE UNIQUE INDEX "qa_plans_siteId_planKey_key" ON "qa_plans"("siteId","planKey");
CREATE INDEX "qa_plans_accountId_siteId_id_idx" ON "qa_plans"("accountId","siteId","id");
CREATE TABLE "qa_plan_revisions" (
 "id" TEXT NOT NULL PRIMARY KEY,"accountId" TEXT NOT NULL,"planId" TEXT NOT NULL,"version" INTEGER NOT NULL CHECK ("version">0),
 "payload" JSONB NOT NULL,"createdByMemberId" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "qa_plan_revisions_planId_accountId_fkey" FOREIGN KEY ("planId","accountId") REFERENCES "qa_plans"("id","accountId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "qa_plan_revisions_planId_version_key" ON "qa_plan_revisions"("planId","version");
CREATE INDEX "qa_plan_revisions_accountId_planId_idx" ON "qa_plan_revisions"("accountId","planId");
CREATE FUNCTION qa_plan_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'QA plan revisions are immutable';
END $$;
CREATE TRIGGER qa_plan_revision_no_update BEFORE UPDATE ON "qa_plan_revisions" FOR EACH ROW EXECUTE FUNCTION qa_plan_revision_immutable();
REVOKE ALL ON FUNCTION qa_plan_revision_immutable() FROM PUBLIC;
REVOKE ALL ON "qa_plans","qa_plan_revisions" FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='assist_public') THEN REVOKE ALL ON "qa_plans","qa_plan_revisions" FROM assist_public; END IF; END $$;
