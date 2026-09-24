-- Подтверждённая подписка на канал («Условно бесплатный Lite» §6,
-- этап 133). Миграция написана руками, как и все остальные; CI сверяет
-- её со схемой через `prisma migrate diff --exit-code`.

CREATE TYPE "UnlockKind" AS ENUM (
  'TELEGRAM_CHANNEL',
  'YOUTUBE_SUBSCRIPTION',
  'YOUTUBE_VIDEO_LIKE'
);

CREATE TABLE "unlock_checks" (
  "id"     TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind"   "UnlockKind" NOT NULL,
  -- Аккаунт, которым подтверждали. Уникален: иначе один аккаунт
  -- открывает доступ любому числу пользователей, и проверка перестаёт
  -- что-либо значить.
  "externalAccountId" TEXT NOT NULL,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "unlock_checks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "unlock_checks_userId_key" ON "unlock_checks" ("userId");
CREATE UNIQUE INDEX "unlock_checks_externalAccountId_key"
  ON "unlock_checks" ("externalAccountId");

ALTER TABLE "unlock_checks"
  ADD CONSTRAINT "unlock_checks_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
