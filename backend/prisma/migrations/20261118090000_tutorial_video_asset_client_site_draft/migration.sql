-- Этап 113 — мягкая ссылка с собранного ролика на черновик обучалки по
-- сайту заказчика (doc/CLIENT-SITE-TUTORIAL-SPEC.md §6.2).
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md), `prisma migrate diff --exit-code` в CI
-- проверит, что она не разошлась со schema.prisma.
--
-- Колонка nullable и без FK намеренно: это журнальная ссылка того же
-- рода, что "scenarioId" рядом — черновик может быть удалён
-- пользователем, и каскадом сносить уже собранный и, возможно, уже
-- опубликованный ролик нельзя.
ALTER TABLE "tutorial_video_assets" ADD COLUMN "clientSiteDraftId" TEXT;

-- §6.2 предполагает фильтр `WHERE clientSiteDraftId IS NOT NULL`.
CREATE INDEX "tutorial_video_assets_clientSiteDraftId_idx" ON "tutorial_video_assets"("clientSiteDraftId");
