-- Окно склейки меряется по сообщениям ТЕСТИРОВЩИКА (аудит этапа 157).
--
-- До этого оно считалось от `updatedAt`, а его двигает любая правка
-- строки: ответ оператора, смена статуса, дописанный `botMessageIds`.
-- Оператор отвечает на вчерашний тикет, тестировщик через минуту
-- присылает новую находку — и она молча уезжает в тот вчерашний тикет.
ALTER TABLE "test_tickets" ADD COLUMN "lastMessageAt" TIMESTAMP(3);

-- Индекс склейки переезжает на новую колонку: по `updatedAt` больше
-- никто не ищет.
DROP INDEX IF EXISTS "test_tickets_userId_source_updatedAt_idx";
CREATE INDEX "test_tickets_userId_source_lastMessageAt_idx"
  ON "test_tickets"("userId", "source", "lastMessageAt");
