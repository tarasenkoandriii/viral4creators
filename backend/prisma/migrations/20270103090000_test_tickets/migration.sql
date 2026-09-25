-- Находки тестировщика (этап 157,
-- `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §3).
--
-- Два входа — бот и кнопка в мини-аппе, — одна сущность: разводить их
-- по двум таблицам значило бы дважды писать очередь разбора и дважды
-- её фильтровать.
CREATE TABLE "test_tickets" (
    "id" TEXT NOT NULL,
    -- Человекочитаемый номер: он уходит тестировщику в подтверждение,
    -- и «принято, #14» в переписке работает, а `cmfz3k…` — нет.
    "number" SERIAL NOT NULL,

    "userId" TEXT NOT NULL,
    "inviteId" TEXT,

    "source" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    -- Вложения и переписка — json: их читают целиком вместе с тикетом
    -- и никогда по отдельности.
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "comments" JSONB NOT NULL DEFAULT '[]',
    -- Идентификаторы НАШИХ сообщений в личке: по ним ответ
    -- тестировщика находит свой тикет и ложится комментарием, а не
    -- новой находкой в очередь.
    "botMessageIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    "sessionId" TEXT,
    "scenario" TEXT,
    "stepId" TEXT,

    -- Локаль интерфейса обязательна, локаль ролика — только у тикетов
    -- из мини-аппа: это разные переводы и разные команды.
    "uiLocale" TEXT NOT NULL,
    "sessionLocale" TEXT,

    "env" JSONB,
    "envKey" TEXT,
    -- Может быть заметно РАНЬШЕ createdAt: из бота берётся последнее
    -- известное окружение, и разрыв сам по себе сигнал.
    "envCapturedAt" TIMESTAMP(3),
    "appBuild" TEXT,

    "status" TEXT NOT NULL DEFAULT 'NEW',
    "statusBy" TEXT,
    "statusAt" TIMESTAMP(3),
    "statusNote" TEXT,

    "replySentAt" TIMESTAMP(3),
    "replyFailedAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "test_tickets_number_key" ON "test_tickets"("number");
-- Очередь разбора: свежие сверху, с фильтром по статусу.
CREATE INDEX "test_tickets_status_createdAt_idx" ON "test_tickets"("status", "createdAt");
-- «Ещё N тикетов с тем же ключом» в карточке.
CREATE INDEX "test_tickets_envKey_idx" ON "test_tickets"("envKey");
CREATE INDEX "test_tickets_userId_idx" ON "test_tickets"("userId");
-- Склейка ищет самый свежий тикет этого человека из бота.
CREATE INDEX "test_tickets_userId_source_updatedAt_idx" ON "test_tickets"("userId", "source", "updatedAt");

ALTER TABLE "test_tickets"
  ADD CONSTRAINT "test_tickets_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_tickets"
  ADD CONSTRAINT "test_tickets_inviteId_fkey"
  FOREIGN KEY ("inviteId") REFERENCES "tester_invites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
