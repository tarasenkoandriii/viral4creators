-- Слайд-шоу, собранные из кадров прогона сценария обучающего видео
-- (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §4.4, этап 98).
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md), `prisma migrate diff --exit-code` в CI
-- проверит, что она не разошлась со schema.prisma.
CREATE TABLE "tutorial_video_assets" (
    "id"                TEXT NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subjectKey"        TEXT NOT NULL,
    "locale"            TEXT NOT NULL,
    "title"             TEXT NOT NULL,
    "scenarioId"        TEXT,
    "frameCount"        INTEGER,
    "blobUrl"           TEXT,
    "externalUrl"       TEXT,
    "durationMs"        INTEGER,
    "reviewed"          BOOLEAN NOT NULL DEFAULT false,
    "assemblyStatus"    TEXT NOT NULL DEFAULT 'pending',
    "assemblyError"     TEXT,
    "assemblyJobId"     TEXT,
    "assemblyStartedAt" TIMESTAMP(3),

    CONSTRAINT "tutorial_video_assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tutorial_video_assets_subjectKey_locale_createdAt_idx" ON "tutorial_video_assets" ("subjectKey", "locale", "createdAt");

CREATE INDEX "tutorial_video_assets_locale_reviewed_subjectKey_idx" ON "tutorial_video_assets" ("locale", "reviewed", "subjectKey");

CREATE INDEX "tutorial_video_assets_assemblyStatus_idx" ON "tutorial_video_assets" ("assemblyStatus");
