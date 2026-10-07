-- Заход 8, C14 (doc/TODO.md: «классификатор регистра зовётся при каждом
-- сохранении брифа»): запомненные ответы классификатора регистра
-- «Особого повода». Ключ — HMAC от модели и текста запроса ключом из
-- CRON_SECRET, само описание не хранится. Срок — 180 дней (уборка в
-- кроне cleanup-sessions по индексу createdAt). Только ответы, которые
-- модель дала: сбой не пишется и спрашивается снова.
--
-- Написана руками (doc/CI.md); `prisma migrate diff --exit-code` в CI
-- сверит её со schema.prisma. Прежних строк нет — таблица новая.
CREATE TABLE "greeting_register_answers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "register" "GreetingRegister" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "greeting_register_answers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "greeting_register_answers_userId_textHash_key" ON "greeting_register_answers"("userId", "textHash");

ALTER TABLE "greeting_register_answers" ADD CONSTRAINT "greeting_register_answers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "greeting_register_answers_createdAt_idx" ON "greeting_register_answers"("createdAt");
