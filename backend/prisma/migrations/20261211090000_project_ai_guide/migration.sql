-- Чекбокс «использовать ИИ» на проекте — «Тонкая красная линия» §3
-- (docs-tz/TZ-Tonkaya-Krasnaya-Liniya.md).
--
-- Имя таблицы — "projects" (`@@map` модели `Project`), а не `Project`:
-- ровно на этом сорвалась миграция 20261209090000 (P3018 / 42P01), и с
-- тех пор есть тест `src/prisma/migration-table-names.spec.ts`.
--
-- Только добавление колонки: NOT NULL с умолчанием, существующим
-- строкам ничего не дописывается отдельным UPDATE. `false` — это и есть
-- «обычный проект», а не «ещё не настроено».
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "aiGuideEnabled" BOOLEAN NOT NULL DEFAULT false;
