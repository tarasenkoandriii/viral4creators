-- Э-С, шаг Ш0.5/Ш0.6 (docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md,
-- риски В-1 и В-2): сроки хранения данных входа и кадров обучалки по
-- сайту заказчика.
--
-- `secretsUsedAt` — отметка последней записи `cookiesEnc`/`credentialsEnc`;
-- крон `client-site-retention` обнуляет обе колонки через 30 дней после
-- неё. Без backfill: у старых строк крон смотрит на `updatedAt`.
--
-- `secretsOneShot` — «одноразово»: стереть данные входа после первой
-- успешной сборки ролика.
--
-- `frameKey` — случайная папка кадров в публичном Blob. Без backfill:
-- кадры старых черновиков уже лежат по старым путям, и переложить их
-- значило бы сломать ссылки в `roundVideoFrames`; они уходят по сроку
-- хранения (`framesPurgedAt`) или с удалением черновика.
ALTER TABLE "client_site_tutorial_drafts"
  ADD COLUMN "secretsUsedAt" TIMESTAMP(3),
  ADD COLUMN "secretsOneShot" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "frameKey" TEXT,
  ADD COLUMN "framesPurgedAt" TIMESTAMP(3);
