-- Этап 89 (прямой запрос владельца продукта после этапа 88.2): «умный»
-- алерт перед удалением проекта показывает, что реально каскадом
-- снесётся из базы (doc/STORAGE-AUDIT.md), а само удаление проекта,
-- товара и сессии больше не сносит строку синхронно в запросе — ставит
-- deletedAt, читающие запросы фильтруют его, а физическую уборку (и
-- каскад БД, и файлы в Blob) уносит новый крон-проход
-- (purgeSoftDeleted{Projects,Items,Sessions}) спустя грейс-период.
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md).
ALTER TABLE "projects" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "projects_deletedAt_idx" ON "projects"("deletedAt");

ALTER TABLE "product_items" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "product_items_deletedAt_idx" ON "product_items"("deletedAt");

ALTER TABLE "sessions" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "sessions_deletedAt_idx" ON "sessions"("deletedAt");
