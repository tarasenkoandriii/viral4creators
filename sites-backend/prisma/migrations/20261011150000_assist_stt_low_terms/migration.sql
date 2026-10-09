-- №113, заход 11: неуверенно распознанные слова голоса посетителя — кандидаты
-- в словарь терминов голосовой карты (`context.terms` Soniox; ТЗ помощника
-- §4-тер.5 «низкая уверенность STT на слове → словарь терминов»,
-- §5-кватер.10 «Предложения из очереди обучения»).
--
-- Строка — (сайт, день UTC, норма фразы, хеш посетителя) + суточный хеш IP:
-- «разных посетителей» = min(разных хешей посетителя, разных хешей IP),
-- повтор того же посетителя в тот же день — `ON CONFLICT DO NOTHING`.
-- Пишут (Р-З11-Б8): план голосовой команды без значений полей и вопрос
-- чата при совпадении со словарём сайта; диктовка в поля — никогда. Текст — уже прошедший разбор фразы карты (без
-- ПД, ссылок, разметки), посетитель — хеш, не id. Хранение — 30 дней
-- (крон `assist-retention`), удаление сайта — каскадом.
--
-- Роль виджета: только INSERT перечисленных колонок (план/чат пишут без
-- цели конфликта и без RETURNING — SELECT ей не нужен). Читает панель
-- редактора основной ролью.
--
-- Пишется РУКАМИ; CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.

-- CreateTable
CREATE TABLE "assist_site_stt_low_terms" (
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "norm" TEXT NOT NULL,
    "word" TEXT NOT NULL,
    "visitorHash" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_stt_low_terms_pkey" PRIMARY KEY ("siteId","day","norm","visitorHash")
);

-- CreateIndex
CREATE INDEX "assist_site_stt_low_terms_accountId_idx" ON "assist_site_stt_low_terms"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_stt_low_terms_createdAt_idx" ON "assist_site_stt_low_terms"("createdAt");

-- AddForeignKey
ALTER TABLE "assist_site_stt_low_terms" ADD CONSTRAINT "assist_site_stt_low_terms_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Аудит P3-9 (б): роль виджета не вставит произвольный размер/формат.
-- Триггером, а не CHECK (CHECK ломает сверку `migrate diff` движком схем
-- Prisma — как `site_browser_jobs_guard`).
CREATE OR REPLACE FUNCTION "assist_site_stt_low_terms_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF char_length(NEW."word") NOT BETWEEN 1 AND 40
     OR char_length(NEW."norm") NOT BETWEEN 1 AND 80
     OR NEW."day" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR NEW."visitorHash" !~ '^[0-9a-f]{32}$'
     OR char_length(NEW."ipHash") NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'assist_site_stt_low_terms: неверная длина или формат' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "assist_site_stt_low_terms_guard"
  BEFORE INSERT OR UPDATE ON "assist_site_stt_low_terms"
  FOR EACH ROW EXECUTE FUNCTION "assist_site_stt_low_terms_guard"();

-- План голосовой команды и вопрос чата (роль виджета): только вставка.
GRANT INSERT ("accountId", "siteId", "day", "norm", "word", "visitorHash", "ipHash") ON "assist_site_stt_low_terms" TO assist_public;
