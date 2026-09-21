-- ТЗ TZ-Greeting-Video-Project-Type.md §3.1 — четвёртый тип проекта:
-- персонализированный ролик-поздравление. Проект остаётся обычной
-- строкой `projects`: `title`/`countryCode`/`currency`/`brandManifestId`
-- используются как есть, просто у такого проекта нет `ProductItem` —
-- всё специфичное уходит в `greeting_briefs` (следующая миграция).
--
-- ОТДЕЛЬНОЙ миграцией, а не вместе с таблицей: Postgres не позволяет
-- ИСПОЛЬЗОВАТЬ значение enum в той же транзакции, в которой оно
-- добавлено, а Prisma выполняет один файл миграции одной транзакцией.
-- Тот же приём, что уже применён для 'CLIENT_SITE' (миграция
-- 20261117090000_project_type_client_site).
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md), `prisma migrate diff --exit-code` в CI
-- проверит, что она не разошлась со schema.prisma.

ALTER TYPE "ProjectType" ADD VALUE 'GREETING_VIDEO';
