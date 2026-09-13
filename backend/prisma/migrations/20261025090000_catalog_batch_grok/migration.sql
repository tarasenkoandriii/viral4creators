-- Доп. запрос владельца продукта: Grok как провайдер для пакетной
-- генерации по каталогу через xAI Batch API (ТЗ
-- VEO-MODEL-VERSION-CHOICE-SPEC.md §13, этап 2 плана реализации §14).
-- Существующие партии не меняются: provider по умолчанию 'veo' — то же
-- поведение, что было до этой миграции.

ALTER TABLE "CatalogBatchRun"
  ADD COLUMN "provider"   TEXT NOT NULL DEFAULT 'veo',
  ADD COLUMN "resolution" TEXT,
  ADD COLUMN "xaiBatchId" TEXT;

-- Новое значение перечисления — строка ждёт, пока воркер соберёт
-- очередь и подаст её как одну пачку в xAI (см. доккомментарий
-- CatalogBatchRun.xaiBatchId в schema.prisma).
ALTER TYPE "CatalogBatchItemStatus" ADD VALUE 'BATCH_QUEUED';
