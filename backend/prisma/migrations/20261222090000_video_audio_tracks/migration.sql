-- Альтернативные звуковые дорожки ролика (этап 138,
-- docs-tz/TZ-Multilingual-YouTube.md §5, §8).
--
-- Одна строка на язык: YouTube принимает по одной дорожке на локаль, и
-- повторный прогон должен править существующую, а не плодить вторую —
-- отсюда уникальность по паре (сессия, локаль). Тот же приём, что у
-- приглашений.
--
-- `sessionId` без внешнего ключа намеренно: дорожка переживает
-- TTL-очистку сессий, ровно как заявка на публикацию. Файл к тому
-- моменту уже у оператора, и терять карточку вместе с сессией нельзя.
CREATE TYPE "AudioTrackStatus" AS ENUM ('READY', 'HANDOVER', 'FAILED');

CREATE TABLE "video_audio_tracks" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "generatedVideoId" TEXT,
  "locale" TEXT NOT NULL,
  "status" "AudioTrackStatus" NOT NULL DEFAULT 'FAILED',
  "speech" TEXT,
  "voicePathname" TEXT,
  "voiceUrl" TEXT,
  "voiceSeconds" DOUBLE PRECISION,
  "overflowSeconds" DOUBLE PRECISION,
  "tempoRate" DOUBLE PRECISION,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "video_audio_tracks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "video_audio_tracks_sessionId_locale_key"
  ON "video_audio_tracks"("sessionId", "locale");
CREATE INDEX "video_audio_tracks_sessionId_idx"
  ON "video_audio_tracks"("sessionId");
