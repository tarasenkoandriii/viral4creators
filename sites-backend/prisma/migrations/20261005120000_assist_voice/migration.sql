-- Э5 ИИ-помощника «Голос». ТЗ помощника §3.5, §4.10, §4-бис.6, §6.3, §7.1–§7.3;
-- план, Приложение А «Этап 5».
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma 7.10, дальше комментарии
-- и права); CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.
--
-- Что здесь:
--  * assist_sites.voiceConfig — голос виджета (вкл. микрофона и озвучки,
--    голос); действует сразу, без публикации персоны;
--  * assist_sites.voiceDailyCapMicroUsd — ручной суточный потолок голоса
--    (оператор платформы); null — по тарифу;
--  * assist_site_conversations.voice — в диалоге был голос (вес 2, §7.1);
--  * assist_budget_reservations.voice — резерв держит и строку голоса;
--  * assist_site_tts_cache — кэш озвучки ответов «Сайта» на 7 дней;
--  * GRANT роли assist_public — в конце, минимальные, с причиной.
--
-- Звук ВОПРОСА посетителя у нас не хранится нигде (транзитом в памяти
-- запроса, у Soniox удаляется в finally — §4.10, Условия п.3.4): таблицы
-- для него нет и не будет.

-- AlterTable
ALTER TABLE "assist_budget_reservations" ADD COLUMN     "voice" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "assist_site_conversations" ADD COLUMN     "voice" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "assist_sites" ADD COLUMN     "voiceConfig" JSONB,
ADD COLUMN     "voiceDailyCapMicroUsd" INTEGER;

-- CreateTable
CREATE TABLE "assist_site_tts_cache" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "audio" BYTEA NOT NULL,
    "characters" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_tts_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assist_site_tts_cache_expiresAt_idx" ON "assist_site_tts_cache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_tts_cache_siteId_key_key" ON "assist_site_tts_cache"("siteId", "key");

-- AddForeignKey
ALTER TABLE "assist_site_tts_cache" ADD CONSTRAINT "assist_site_tts_cache_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ══ Роль assist_public (виджет) — минимум для голоса ══

-- Доступность голоса и потолок сайта: конфиг виджета и маршруты
-- `/widget/v1/voice`, `/widget/v1/tts` (assist-site-voice/public).
GRANT SELECT ("voiceConfig", "voiceDailyCapMicroUsd") ON "assist_sites" TO assist_public;
-- Отметка «в диалоге был голос» (вес 2) — условным UPDATE … WHERE NOT "voice".
-- Остальные колонки диалога — как в Э3 (колоночный UPDATE).
GRANT UPDATE ("voice") ON "assist_site_conversations" TO assist_public;
-- assist_budget_reservations / assist_budget_days: табличные SELECT/INSERT
-- Э2 уже покрывают новую колонку `voice` и строку `scope='voice'`; UPDATE
-- строк дня — те же колонки денег (Э3), нового не нужно.
-- Кэш озвучки: чтение своей записи по (siteId, key) и вставка без цели
-- конфликта (`ON CONFLICT DO NOTHING`). UPDATE/DELETE — нет: просроченное
-- снимает крон основной ролью, счётчика попаданий нет.
GRANT SELECT ("siteId", "key", "mime", "audio", "expiresAt") ON "assist_site_tts_cache" TO assist_public;
GRANT INSERT ("id", "siteId", "key", "voice", "lang", "mime", "audio", "characters", "expiresAt") ON "assist_site_tts_cache" TO assist_public;
