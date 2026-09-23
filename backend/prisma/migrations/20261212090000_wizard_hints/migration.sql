-- Кеш и журнал подсказок мастера — «Тонкая красная линия» §5.5, §8.
--
-- Имена таблиц — как в `@@map` (`wizard_hint_cache`, `wizard_hints`), а
-- не имена моделей: ровно на этом сорвалась миграция 20261209090000
-- (P3018 / 42P01); проверяется `src/prisma/migration-table-names.spec.ts`.
--
-- Только создание таблиц: ни одного ALTER существующих колонок и ни
-- одного нового значения enum — добавление значения в enum и его
-- использование в одной транзакции уже ломало нам деплой.
CREATE TABLE IF NOT EXISTS "wizard_hint_cache" (
  "key"       TEXT PRIMARY KEY,
  "hint"      TEXT NOT NULL,
  "actions"   JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "hits"      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "wizard_hint_cache_createdAt_idx"
  ON "wizard_hint_cache" ("createdAt");

CREATE TABLE IF NOT EXISTS "wizard_hints" (
  "id"           TEXT PRIMARY KEY,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "scenario"     TEXT NOT NULL,
  "stepId"       TEXT NOT NULL,
  "locale"       TEXT NOT NULL,
  "source"       TEXT NOT NULL,
  "hint"         TEXT NOT NULL,
  "inTokens"     INTEGER NOT NULL DEFAULT 0,
  "outTokens"    INTEGER NOT NULL DEFAULT 0,
  "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
  "latencyMs"    INTEGER NOT NULL DEFAULT 0,
  "flagged"      BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS "wizard_hints_createdAt_idx"
  ON "wizard_hints" ("createdAt");
CREATE INDEX IF NOT EXISTS "wizard_hints_flagged_createdAt_idx"
  ON "wizard_hints" ("flagged", "createdAt");
