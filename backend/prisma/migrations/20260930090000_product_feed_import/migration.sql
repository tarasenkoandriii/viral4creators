-- Этап 68 (TODO §Уровень 2 п.8, doc/PRODUCT-PROJECT-SPEC.md §47). Импорт
-- товарного фида по ссылке (YML/CSV) — разовый снимок каталога, не
-- периодическая синхронизация. ProductFeedImportRun — один запуск
-- импорта одной ссылки; ProductFeedImportItem — состояние одной строки
-- разобранного фида, с бэкоффом по строке, тот же приём, что у
-- catalog_batch_items (этап 65) и ab_test_variants (этап 66).

CREATE TYPE "ProductFeedImportRunStatus" AS ENUM ('PENDING', 'IMPORTING', 'DONE', 'FAILED');

CREATE TABLE "product_feed_import_runs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "status" "ProductFeedImportRunStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "error" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "product_feed_import_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_feed_import_runs_projectId_idx" ON "product_feed_import_runs"("projectId");
CREATE INDEX "product_feed_import_runs_status_nextAttemptAt_idx" ON "product_feed_import_runs"("status", "nextAttemptAt");

ALTER TABLE "product_feed_import_runs" ADD CONSTRAINT "product_feed_import_runs_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_feed_import_runs" ADD CONSTRAINT "product_feed_import_runs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "ProductFeedImportItemStatus" AS ENUM ('PENDING', 'IMPORTED', 'SKIPPED', 'FAILED');

CREATE TABLE "product_feed_import_items" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "title" TEXT,
    "price" DECIMAL(12,2),
    "currency" TEXT,
    "description" TEXT,
    "photoUrl" TEXT,
    "categoryText" TEXT,
    "productItemId" TEXT,
    "status" "ProductFeedImportItemStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_feed_import_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_feed_import_items_runId_idx" ON "product_feed_import_items"("runId");
CREATE INDEX "product_feed_import_items_status_nextAttemptAt_idx" ON "product_feed_import_items"("status", "nextAttemptAt");

ALTER TABLE "product_feed_import_items" ADD CONSTRAINT "product_feed_import_items_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "product_feed_import_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
