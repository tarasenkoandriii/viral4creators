-- Финальный аудит ветки K ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md
-- (30.09.2026): надёжное удаление голосовых записей в пределах часа.
--
-- Каждая выданная ссылка на загрузку записи (реплика мастера, реплика
-- брифа до сессии, диктовка описания товара) заводит строку; обработка
-- удаляет её вместе с файлом в `finally`. Строки старше часа — записи,
-- которые никто не обработал: их файлы и строки удаляет крон
-- `voice-uploads-sweep` каждые 15 минут. Суточная метла `sweep-orphans`
-- остаётся страховкой.
--
-- Только аддитивно: новая таблица, имя — как в `@@map`.

CREATE TABLE IF NOT EXISTS "voice_uploads" (
  "pathname"  TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "voice_uploads_createdAt_idx"
  ON "voice_uploads" ("createdAt");
