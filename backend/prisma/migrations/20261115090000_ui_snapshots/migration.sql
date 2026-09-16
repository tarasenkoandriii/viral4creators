-- Метаданные крон-обхода интерфейса (Часть А ТЗ, §3
-- doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 100).
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md), `prisma migrate diff --exit-code` в CI
-- проверит, что она не разошлась со schema.prisma.
CREATE TABLE "ui_snapshots" (
    "id"            TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "routeKey"      TEXT NOT NULL,
    "locale"        TEXT NOT NULL,
    "theme"         TEXT NOT NULL DEFAULT 'light',
    "blobUrl"       TEXT,
    "comparedToUrl" TEXT,
    "diffHash"      TEXT,
    "diffScore"     DOUBLE PRECISION,
    "changed"       BOOLEAN NOT NULL DEFAULT false,
    "error"         TEXT,

    CONSTRAINT "ui_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ui_snapshots_routeKey_locale_theme_createdAt_idx" ON "ui_snapshots" ("routeKey", "locale", "theme", "createdAt");
