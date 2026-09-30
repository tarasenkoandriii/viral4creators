-- Этап K1 ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md (§4А.4,
-- §4А.5, решение В-10): голос советника.
--
-- 1. Переключатель «голосом» на проекте — рядом с чекбоксом советника,
--    по умолчанию выключен: синтез стоит денег на каждой новой подсказке.
-- 2. Аудиокеш озвученных подсказок: одна и та же подсказка тем же
--    голосом на том же языке не синтезируется дважды. Ключ — хеш от
--    ключа подсказки, голоса, языка и самого текста (строка кеша
--    подсказки переписывается по тому же ключу, когда протухает).
--    `lastUsedAt` — для суточной уборки: строка и файл, не звучавшие
--    30 дней, удаляются (`pruneWizardHintAudio`, крон cleanup-sessions).
--
-- Имена таблиц — как в `@@map` (`projects`, `wizard_hint_audio`); только
-- аддитивные изменения, без новых значений enum.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "aiGuideVoice" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "wizard_hint_audio" (
  "key"        TEXT PRIMARY KEY,
  "hintKey"    TEXT NOT NULL,
  "provider"   TEXT NOT NULL,
  "voiceId"    TEXT NOT NULL,
  "lang"       TEXT NOT NULL,
  "pathname"   TEXT NOT NULL,
  "url"        TEXT NOT NULL,
  "characters" INTEGER NOT NULL,
  "hits"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "wizard_hint_audio_hintKey_idx"
  ON "wizard_hint_audio" ("hintKey");
CREATE INDEX IF NOT EXISTS "wizard_hint_audio_lastUsedAt_idx"
  ON "wizard_hint_audio" ("lastUsedAt");
