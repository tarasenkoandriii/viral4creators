-- Пятый аудит: два независимых индекса, найденных как «средняя»/«низкая»
-- находки в разделе Г.4 (БД/производительность).
--
-- Д-4.2: вкладка «Кроны» в дефолтном режиме (без jobKey) сортирует
-- cron_run_logs по startedAt без фильтра — составной индекс с ведущей
-- jobKey тут не помогает (тот же класс, что publication_requests,
-- В-4.5, этап 51, и три истории партий/A-B/фида, Д-4.1).
--
-- Д-4.6: проверка «занятости» товара при создании партии
-- (CatalogBatchService.create()) ищет по productItemId IN (...) поперёк
-- партий — ни составной unique (ведущая batchId), ни индекс по
-- (status, nextAttemptAt) её не покрывают.

CREATE INDEX "cron_run_logs_startedAt_idx" ON "cron_run_logs"("startedAt");
CREATE INDEX "catalog_batch_items_productItemId_idx" ON "catalog_batch_items"("productItemId");
