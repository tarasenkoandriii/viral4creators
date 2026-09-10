-- Пятый аудит (Д-4.1): три истории админки («Партии», «A/B-запуски»,
-- «Импорт фида») сортируют по createdAt без покрывающего индекса —
-- существующий индекс на projectId не помогает несфильтрованному по
-- проекту списку. Тот же класс, что publication_requests уже закрыл
-- (этап 51, В-4.5).
CREATE INDEX "catalog_batch_runs_createdAt_idx" ON "catalog_batch_runs"("createdAt");
CREATE INDEX "ab_test_runs_createdAt_idx" ON "ab_test_runs"("createdAt");
CREATE INDEX "product_feed_import_runs_createdAt_idx" ON "product_feed_import_runs"("createdAt");
