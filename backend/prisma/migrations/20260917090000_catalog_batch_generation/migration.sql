-- Этап 65 (ТЗ §44, doc/TODO.md §III.5). Пакетная генерация по каталогу:
-- один уже одобренный ролик (разбор + промпт) переносится на все
-- остальные товары линейки за один заход. CatalogBatchRun — снимок
-- одного запуска партии (какой разбор, чей стиль, какой пользователь),
-- CatalogBatchItem — состояние обработки одного товара партии, с
-- бэкоффом по строке, тот же приём, что у publication_requests (этап
-- 61) и marketing_deliveries (этап 63).

CREATE TABLE "catalog_batch_runs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "libraryEntryId" TEXT NOT NULL,
    "sourceSessionId" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "aspectRatio" TEXT,
    "locale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_batch_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catalog_batch_runs_projectId_idx" ON "catalog_batch_runs"("projectId");

ALTER TABLE "catalog_batch_runs" ADD CONSTRAINT "catalog_batch_runs_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_batch_runs" ADD CONSTRAINT "catalog_batch_runs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "CatalogBatchItemStatus" AS ENUM ('PENDING', 'GENERATING', 'DONE', 'FAILED');

CREATE TABLE "catalog_batch_items" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "productItemId" TEXT NOT NULL,
    "sessionId" TEXT,
    "status" "CatalogBatchItemStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_batch_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "catalog_batch_items_batchId_productItemId_key" ON "catalog_batch_items"("batchId", "productItemId");
CREATE INDEX "catalog_batch_items_status_nextAttemptAt_idx" ON "catalog_batch_items"("status", "nextAttemptAt");

ALTER TABLE "catalog_batch_items" ADD CONSTRAINT "catalog_batch_items_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "catalog_batch_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_batch_items" ADD CONSTRAINT "catalog_batch_items_productItemId_fkey"
    FOREIGN KEY ("productItemId") REFERENCES "product_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
