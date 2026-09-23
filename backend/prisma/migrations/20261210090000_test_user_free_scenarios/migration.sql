-- Тестовые пользователи с бесплатным использованием по сценариям
-- (TODO §III п.37).
--
-- Имя таблицы — "users" (`@@map` модели `User`), а не `User`: ровно на
-- этом сорвалась миграция 20261209090000 (P3018 / 42P01). Проверяется
-- тестом `src/prisma/migration-table-names.spec.ts`.
--
-- Обе колонки NOT NULL с умолчанием, поэтому существующим строкам
-- ничего не дописывается отдельным UPDATE: false и пустой массив — это
-- и есть «обычный пользователь», а не «ещё не настроено».
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "isTestUser" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "freeScenarios" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
