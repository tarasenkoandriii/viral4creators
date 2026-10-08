-- Заход 9, пакет D — хвосты Э3-бис «Аналитика с ИИ» (doc/TODO.md, I-Э3б):
--  * Р-З9-26 (хвост аудита (1)): флаг «связан с визитом» в разметке
--    диалога. Калибровка lead score отличает «не купил» по связанному
--    режиму — раньше по `visitHash` диалога, из-за чего хеш визита нельзя
--    было обнулять (жил как диалог, ТЗ §5-тер.15 — «визиты 30 дней + 1»).
--    Теперь калибровка читает флаг, а суточный крон обнуляет `visitHash`
--    диалогов старше 31 дня. Существующие разметки — флаг по текущему хешу.
--  * Хвост (5): имя пакетного задания Gemini Batch API у разметки в
--    статусе `batch` (код за выключателем ASSIST_LABEL_BATCH, умолчание —
--    выключен).
--  * Р-З9-25 (хвост (6)): доля выборки итога просмотра сверх квоты тарифа
--    (`sampleRate`, ТЗ §5-тер.10 «sampleRate в строке»); свёртка делит
--    счётчики на неё. Роль виджета вставляет её вместе с итогом.
--
-- Пишется РУКАМИ; CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.

-- AlterTable
ALTER TABLE "assist_site_conversation_labels" ADD COLUMN     "batchJob" TEXT,
ADD COLUMN     "linked" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "assist_site_page_views" ADD COLUMN     "sampleRate" DOUBLE PRECISION NOT NULL DEFAULT 1;

-- Разметки, сделанные до флага: «связан» — если у диалога сейчас есть хеш визита.
UPDATE "assist_site_conversation_labels" l
   SET "linked" = true
  FROM "assist_site_conversations" c
 WHERE c."id" = l."conversationId" AND c."visitHash" IS NOT NULL;

-- Итог просмотра сверх квоты пишется с долей выборки (только эта колонка).
GRANT INSERT ("sampleRate") ON "assist_site_page_views" TO assist_public;

-- Частичные индексы (аудит захода 9, P3-7/P3-8). Prisma их не описывает и
-- `migrate diff` их не трогает (проверено): живут только здесь.
-- Пакетные задания разметки — строки в статусе `batch` (единицы на фоне
-- всех разметок): опрос заданий и проверка «есть ли они» каждый тик.
CREATE INDEX "assist_site_conversation_labels_batch_partial_idx"
    ON "assist_site_conversation_labels" ("batchJob", "labeledAt")
    WHERE "status" = 'batch';

-- Обнуление хеша визита диалогов через 31 день (суточный крон): только
-- связанные диалоги, по времени последнего сообщения.
CREATE INDEX "assist_site_conversations_visit_partial_idx"
    ON "assist_site_conversations" ("lastMessageAt")
    WHERE "visitHash" IS NOT NULL;
