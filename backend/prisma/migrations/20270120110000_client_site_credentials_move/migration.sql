-- Э-С, шаг Ш2 (docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md
-- §3.2; план docs-tz/AI-Pomoshchnik-Plan-Etapov.md, «Э-С», Ш2): данные
-- входа черновика обучалки переезжают в хранилище sites-backend.
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md), `prisma migrate diff --exit-code` в CI
-- проверит, что она не разошлась со schema.prisma.
--
-- Ссылки на запись хранилища (без FK — другая база):
--  * `siteTestAccountId` — режим A, учётка реестра сайта (`site_test_accounts`);
--  * `userSiteSessionId` — режим B, личная запись (`user_site_sessions`).
-- Без backfill: перенос существующих — скрипт
-- `backend/scripts/move-client-site-credentials.ts` (dry-run по умолчанию).
-- Колонки `credentialsEnc`/`cookiesEnc` НЕ удаляются здесь: удаление —
-- отдельной миграцией после переноса на проде (doc/TODO.md I-М).
-- `storeHasCredentials` — в хранилище лежат поля формы входа: признак
-- «данные входа сохранены» без похода в sites-backend на каждом показе.
ALTER TABLE "client_site_tutorial_drafts"
  ADD COLUMN "siteTestAccountId" TEXT,
  ADD COLUMN "userSiteSessionId" TEXT,
  ADD COLUMN "storeHasCredentials" BOOLEAN NOT NULL DEFAULT false;
