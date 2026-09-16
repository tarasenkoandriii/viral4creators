-- Сценарии для автозаписи обучающего видео, сгенерированные ИИ по
-- крону `tutorial-scenario-generate`, а не написанные разработчиком
-- руками (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §4.10/§4.11,
-- этап 94). Написана руками — сеть до binaries.prisma.sh недоступна в
-- песочнице разработки (doc/CI.md), `prisma migrate diff --exit-code`
-- в CI проверит, что она не разошлась со schema.prisma.
CREATE TABLE "tutorial_scenarios" (
    "id"                    TEXT NOT NULL,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subjectKey"            TEXT NOT NULL,
    "locale"                TEXT NOT NULL,
    "steps"                 JSONB NOT NULL,
    "generatedBy"           TEXT NOT NULL DEFAULT 'ai',
    "costly"                BOOLEAN NOT NULL DEFAULT false,
    "estimatedCostMicroUsd" INTEGER,
    "costUnpriced"          BOOLEAN NOT NULL DEFAULT false,
    "approved"              BOOLEAN NOT NULL DEFAULT false,
    "approvedBy"            TEXT,
    "approvedAt"            TIMESTAMP(3),
    "lastRunAt"             TIMESTAMP(3),
    "lastRunStatus"         TEXT,
    "lastRunError"          TEXT,

    CONSTRAINT "tutorial_scenarios_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tutorial_scenarios_subjectKey_locale_createdAt_idx" ON "tutorial_scenarios" ("subjectKey", "locale", "createdAt");

CREATE INDEX "tutorial_scenarios_costly_approved_idx" ON "tutorial_scenarios" ("costly", "approved");
