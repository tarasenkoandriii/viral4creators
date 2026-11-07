-- Private metadata only; deliberately no FK to temporary sessions.
CREATE TABLE "generation_history_runs" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "provider" TEXT,
  "model" TEXT,
  "resolution" TEXT,
  "durationSeconds" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "generation_history_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "generation_history_runs_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "generation_history_runs_duration_check" CHECK ("durationSeconds" IS NULL OR "durationSeconds" > 0),
  CONSTRAINT "generation_history_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "generation_history_runs_userId_createdAt_id_idx" ON "generation_history_runs"("userId", "createdAt", "id");
CREATE INDEX "generation_history_runs_userId_sessionId_idx" ON "generation_history_runs"("userId", "sessionId");

-- History is exposed only by the authenticated backend, never by PostgREST.
ALTER TABLE "generation_history_runs" ENABLE ROW LEVEL SECURITY;
