CREATE TABLE "generation_history_events" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "runId" TEXT NOT NULL,
 "revision" INTEGER NOT NULL CHECK ("revision" >= 0),
 "kind" TEXT NOT NULL CHECK ("kind" IN ('snapshot', 'transition')),
 "fromStatus" TEXT,
 "status" TEXT NOT NULL,
 "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "generation_history_events_runId_fkey" FOREIGN KEY ("runId") REFERENCES "generation_history_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "generation_history_events_runId_revision_key" ON "generation_history_events"("runId", "revision");

-- No policies: ordinary API roles cannot read or write another user's history.
ALTER TABLE "generation_history_events" ENABLE ROW LEVEL SECURITY;
