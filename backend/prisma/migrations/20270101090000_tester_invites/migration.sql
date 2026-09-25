-- Приглашение тестировщика (этап 155,
-- `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §2).
--
-- Единственный способ впустить тестировщика: Telegram не даёт боту
-- написать первым, и приватный диалог создаётся только тем, что человек
-- сам нажал START по ссылке `t.me/<bot>?start=t_<token>`.
CREATE TABLE "tester_invites" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "freeScenarios" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "userId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tester_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tester_invites_token_key" ON "tester_invites"("token");
CREATE INDEX "tester_invites_userId_idx" ON "tester_invites"("userId");
CREATE INDEX "tester_invites_createdAt_idx" ON "tester_invites"("createdAt");

ALTER TABLE "tester_invites"
  ADD CONSTRAINT "tester_invites_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Срок тестового доступа. NULL — бессрочно, как было до приглашений.
ALTER TABLE "users" ADD COLUMN "testAccessUntil" TIMESTAMP(3);

-- Когда человек НАЖАЛ START в личке с ботом.
--
-- Это НЕ то же, что наличие `telegramId`: идентификатор появляется при
-- входе в мини-апп, у людей, никогда не открывавших диалог с ботом.
-- Права писать им он не даёт — Telegram отвечает `bot can't initiate
-- conversation with a user`. Колонка — единственный признак, по
-- которому право известно ДО отправки.
ALTER TABLE "users" ADD COLUMN "botChatOpenedAt" TIMESTAMP(3);
