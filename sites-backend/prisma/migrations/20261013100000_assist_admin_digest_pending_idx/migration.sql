-- Заход 13, пакет Г (хвост захода 11 «`pendingRows` — полный проход раз в
-- тик»): досылка отчёта недели «Админки» (`AdminWeeklyDigest.pendingRows`)
-- каждый тик крона ищет строки с непустым ожиданием сводки. Без индекса это
-- полный проход `assist_admin_insights` (строка на сайт × неделю — таблица
-- растёт без конца), хотя ждущих строк — единицы и только в день отчёта.
--
-- Частичный индекс: в нём только строки, которые ждут (условие — то же, что
-- в WHERE запроса, планировщик выводит его дословно), порядок — по
-- "digestPendingAt" (ORDER BY … LIMIT запроса). Строка уходит из индекса,
-- как только ожидание опустело (`takeRest`/`claim` — пустой массив).
-- Частичный — Prisma его не описывает и diff его не видит.
--
-- Только аддитивно: новый индекс, данные не меняются.
CREATE INDEX "assist_admin_insights_digest_pending_idx"
    ON "assist_admin_insights" ("digestPendingAt")
    WHERE cardinality("digestPending") > 0 AND "digestPendingAt" IS NOT NULL;
