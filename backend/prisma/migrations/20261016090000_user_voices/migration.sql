-- Этап 73 (TODO п.32, doc/AI-ACTORS-NO-REFERENCE-SPEC.md §3,
-- doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.3). Клонирование голоса
-- пользователем через Resemble AI — асинхронный поток (TRAINING сразу
-- после отправки образца, READY/FAILED по вебхуку или poll-фоллбеку),
-- голос принадлежит подписчику, не BrandManifest.

CREATE TYPE "UserVoiceStatus" AS ENUM ('TRAINING', 'READY', 'FAILED');

CREATE TABLE "user_voices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "UserVoiceStatus" NOT NULL DEFAULT 'TRAINING',
    "resembleVoiceId" TEXT,
    "sampleUrl" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_voices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_voices_userId_idx" ON "user_voices"("userId");
CREATE INDEX "user_voices_resembleVoiceId_idx" ON "user_voices"("resembleVoiceId");

ALTER TABLE "user_voices" ADD CONSTRAINT "user_voices_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
