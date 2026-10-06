-- Метаданные роликов обучалки для выдачи и актуальности демо (заход 1
-- после аудита кронов обучалки, 06.10.2026; doc/TODO.md II «Актуальное
-- демо трёх лендингов и TMA»): размер холста — пропорция превью на
-- лендинге до загрузки ролика, постер — первый кадр, тема съёмки, время
-- съёмки и версия интерфейса — проверка актуальности оператором.
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md); `prisma migrate diff --exit-code` в CI проверит,
-- что она не разошлась со schema.prisma.
ALTER TABLE "tutorial_video_assets"
  ADD COLUMN "width" INTEGER,
  ADD COLUMN "height" INTEGER,
  ADD COLUMN "posterUrl" TEXT,
  ADD COLUMN "theme" TEXT,
  ADD COLUMN "capturedAt" TIMESTAMP(3),
  ADD COLUMN "captureBuild" TEXT;

-- Все ролики до этой миграции собраны на одном холсте 720×1560
-- (`CANVAS`, tutorial-video-assembly.ts) и в светлой теме
-- (`SCENARIO_THEME`; обучалка по сайту заказчика снимается в той теме,
-- что у сайта, — тему ей не приписываем). Время съёмки ≈ создание строки.
UPDATE "tutorial_video_assets"
   SET "width" = 720, "height" = 1560, "capturedAt" = "createdAt"
 WHERE "assemblyStatus" = 'complete';
UPDATE "tutorial_video_assets"
   SET "theme" = 'light'
 WHERE "assemblyStatus" = 'complete' AND "clientSiteDraftId" IS NULL;
