-- Этап 111 — новый тип проекта для обучалки по сайту заказчика
-- (doc/CLIENT-SITE-TUTORIAL-SPEC.md §4.1). Проект остаётся обычной
-- строкой `projects`: `title`/`countryCode`/`currency`/`brandManifestId`
-- используются как есть, просто у такого проекта нет `ProductItem` —
-- всё специфичное уходит в `client_site_tutorial_drafts` (§6.1,
-- следующая миграция).
--
-- ОТДЕЛЬНОЙ миграцией, а не вместе с таблицами: Postgres не позволяет
-- ИСПОЛЬЗОВАТЬ значение enum в той же транзакции, в которой оно
-- добавлено, а Prisma выполняет один файл миграции одной транзакцией.
-- Тот же приём, что уже применён для `CatalogBatchItemStatus`
-- ('BATCH_QUEUED', миграция 20261025090000_catalog_batch_grok).
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md), `prisma migrate diff --exit-code` в CI
-- проверит, что она не разошлась со schema.prisma.

ALTER TYPE "ProjectType" ADD VALUE 'CLIENT_SITE';
