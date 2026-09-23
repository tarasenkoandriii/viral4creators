-- Телеметрия шагов мастера («Тонкая красная линия» §8, этап 8).
--
-- Имя таблицы — как в `@@map`, а не имя модели: на этом уже сорвалась
-- миграция 20261209090000 (P3018 / 42P01), и с тех пор соответствие
-- проверяет `src/prisma/migration-table-names.spec.ts`.
--
-- Ни одного идентифицирующего поля — это не упущение, а требование §8:
-- считаются частоты по шагам, а не люди.
CREATE TABLE IF NOT EXISTS "wizard_step_events" (
  "id"        TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "scenario"  TEXT NOT NULL,
  "stepId"    TEXT NOT NULL,
  "kind"      TEXT NOT NULL,
  "detail"    TEXT,

  CONSTRAINT "wizard_step_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "wizard_step_events_scenario_stepId_kind_createdAt_idx"
  ON "wizard_step_events" ("scenario", "stepId", "kind", "createdAt");

CREATE INDEX IF NOT EXISTS "wizard_step_events_createdAt_idx"
  ON "wizard_step_events" ("createdAt");
