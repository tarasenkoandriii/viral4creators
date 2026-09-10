-- Этап 51 (В-4.1, В-4.5): статус рендера — колонка, а не JSON-путь.
-- Телеметрия считала провалы фильтром по `data->'generatedVideo'->>'status'`
-- и распаковывала всю колонку `data` у каждой строки.
ALTER TABLE "sessions" ADD COLUMN "generationStatus" TEXT;

-- Заполнение существующих строк. Одноразовый полный проход по таблице —
-- на штатном объёме (сутки TTL) это тысячи строк.
UPDATE "sessions"
SET "generationStatus" = "data" -> 'generatedVideo' ->> 'status'
WHERE "data" -> 'generatedVideo' IS NOT NULL;

CREATE INDEX "sessions_generationStatus_idx" ON "sessions"("generationStatus");
CREATE INDEX "sessions_status_idx" ON "sessions"("status");

-- Пункт «Все» в модерации: сортировка по времени без фильтра по статусу.
CREATE INDEX "publication_requests_createdAt_idx" ON "publication_requests"("createdAt");
