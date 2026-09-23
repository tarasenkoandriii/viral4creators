-- Корпус опыта советника («Тонкая красная линия» §6.2, этап 9).
--
-- Имена таблиц — как в `@@map` (проверяет
-- `src/prisma/migration-table-names.spec.ts`). Только создание таблиц:
-- ни одного ALTER существующих колонок и ни одного нового значения
-- enum — `status`, `origin`, `source` и `decision` здесь обычные
-- строки с проверкой в коде, ровно как `freeScenarios` у тестовых
-- аккаунтов.
CREATE TABLE IF NOT EXISTS "wizard_experience" (
  "id"          TEXT NOT NULL,
  "scenario"    TEXT NOT NULL,
  "stepId"      TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'DRAFT',
  "createdBy"   TEXT,
  "publishedBy" TEXT,
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wizard_experience_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "wizard_experience_scenario_stepId_status_idx"
  ON "wizard_experience" ("scenario", "stepId", "status");

CREATE TABLE IF NOT EXISTS "wizard_experience_texts" (
  "id"           TEXT NOT NULL,
  "experienceId" TEXT NOT NULL,
  "locale"       TEXT NOT NULL,
  "symptom"      TEXT NOT NULL,
  "cause"        TEXT,
  "advice"       TEXT NOT NULL,
  "source"       TEXT NOT NULL,
  "reviewed"     BOOLEAN NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wizard_experience_texts_pkey" PRIMARY KEY ("id")
);

-- На язык ровно один совет (§6.2).
CREATE UNIQUE INDEX IF NOT EXISTS "wizard_experience_texts_experienceId_locale_key"
  ON "wizard_experience_texts" ("experienceId", "locale");

CREATE TABLE IF NOT EXISTS "wizard_experience_candidates" (
  "id"         TEXT NOT NULL,
  "scenario"   TEXT NOT NULL,
  "stepId"     TEXT NOT NULL,
  "locale"     TEXT NOT NULL,
  "rawText"    TEXT NOT NULL,
  "origin"     TEXT NOT NULL,
  "status"     TEXT NOT NULL DEFAULT 'NEW',
  "matchedId"  TEXT,
  "matchScore" DOUBLE PRECISION,
  "decision"   TEXT,
  "why"        TEXT,
  "decidedBy"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wizard_experience_candidates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "wizard_experience_candidates_scenario_stepId_status_idx"
  ON "wizard_experience_candidates" ("scenario", "stepId", "status");

CREATE INDEX IF NOT EXISTS "wizard_experience_candidates_matchedId_idx"
  ON "wizard_experience_candidates" ("matchedId");

CREATE INDEX IF NOT EXISTS "wizard_experience_candidates_createdAt_idx"
  ON "wizard_experience_candidates" ("createdAt");

-- Связи. `ON DELETE CASCADE` у текстов: совет без ситуации бессмыслен.
-- `ON DELETE SET NULL` у кандидата: удалённая ситуация не должна
-- уносить с собой сигнал с поля — он ещё пригодится оператору.
ALTER TABLE "wizard_experience_texts"
  DROP CONSTRAINT IF EXISTS "wizard_experience_texts_experienceId_fkey";
ALTER TABLE "wizard_experience_texts"
  ADD CONSTRAINT "wizard_experience_texts_experienceId_fkey"
  FOREIGN KEY ("experienceId") REFERENCES "wizard_experience"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wizard_experience_candidates"
  DROP CONSTRAINT IF EXISTS "wizard_experience_candidates_matchedId_fkey";
ALTER TABLE "wizard_experience_candidates"
  ADD CONSTRAINT "wizard_experience_candidates_matchedId_fkey"
  FOREIGN KEY ("matchedId") REFERENCES "wizard_experience"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
