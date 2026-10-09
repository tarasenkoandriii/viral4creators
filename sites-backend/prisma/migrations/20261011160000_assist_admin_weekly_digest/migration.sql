-- Заход 11, пакет В (Р-З11-В3): отчёт недели «Админки» — разделом утренней
-- сводки `assist-digest` в день отчёта, без второго сообщения.
--
--  * "digestPending" — chat id получателей (строкой), чей отчёт ждёт
--    сегодняшней сводки; сводка забирает id по одному условным UPDATE
--    (`array_remove … WHERE $id = ANY(…)`), остаток досылает крон «Админки»
--    отдельным сообщением после прохода сводки — каждому ровно одно;
--  * "digestPendingAt" — когда поставлено в ожидание;
--  * "digestTexts" — готовые тексты отчёта на uk/ru/en (без ПД: агрегаты и
--    название сайта).
--
-- Только аддитивно: новые столбцы с умолчаниями, прежние строки не меняются.

ALTER TABLE "assist_admin_insights"
  ADD COLUMN "digestPending" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "digestPendingAt" TIMESTAMP(3),
  ADD COLUMN "digestTexts" JSONB;
