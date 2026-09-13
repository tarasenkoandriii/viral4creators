-- Доп. запрос владельца продукта: Grok как провайдер для пакетной
-- генерации по каталогу через xAI Batch API (ТЗ
-- VEO-MODEL-VERSION-CHOICE-SPEC.md §13, этап 2 плана реализации §14).
-- Существующие партии не меняются: provider по умолчанию 'veo' — то же
-- поведение, что было до этой миграции.
--
-- ИСПРАВЛЕНО (провалилось на продакшне 2026-09-13, P3009): модель
-- `CatalogBatchRun` замаплена на `@@map("catalog_batch_runs")` —
-- реальное имя таблицы в Postgres snake_case, не PascalCase модели.
-- Первая версия этого файла ссылалась на несуществующую `"CatalogBatchRun"`.

ALTER TABLE "catalog_batch_runs"
  ADD COLUMN "provider"   TEXT NOT NULL DEFAULT 'veo',
  ADD COLUMN "resolution" TEXT,
  ADD COLUMN "xaiBatchId" TEXT;

-- Новое значение перечисления — строка ждёт, пока воркер соберёт
-- очередь и подаст её как одну пачку в xAI (см. доккомментарий
-- CatalogBatchRun.xaiBatchId в schema.prisma). У enum'а нет @@map —
-- имя типа в Postgres совпадает с именем в Prisma.
ALTER TYPE "CatalogBatchItemStatus" ADD VALUE 'BATCH_QUEUED';
