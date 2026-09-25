-- Короткоживущий вход через Google ради одной проверки подписки
-- («Условно бесплатный Lite» §6.3, этап 140).
--
-- Отдельная таблица, а не строка в `publishing_channels`: тот хранит
-- долгоживущий грант на ЗАГРУЗКУ роликов, а здесь нужен токен на десять
-- минут и только на чтение. Держать ради разовой проверки второй
-- постоянный токен — лишний риск без выигрыша.
--
-- Refresh-токена в таблице нет и не будет: продлить эту сессию нечем
-- даже по ошибке. Индекс по `expiresAt` — для уборки: забытые строки
-- (человек начал вход и не закончил) подбирает крон.
CREATE TABLE "youtube_unlock_sessions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accessTokenEnc" TEXT NOT NULL,
  "googleChannelId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "youtube_unlock_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "youtube_unlock_sessions_userId_key"
  ON "youtube_unlock_sessions"("userId");
CREATE INDEX "youtube_unlock_sessions_expiresAt_idx"
  ON "youtube_unlock_sessions"("expiresAt");

ALTER TABLE "youtube_unlock_sessions"
  ADD CONSTRAINT "youtube_unlock_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
