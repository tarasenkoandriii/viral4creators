-- По итогам аудита БД (см. doc/DATABASE-AUDIT.md, находка №4):
-- admin_sessions.token и user_sessions.token уже покрыты уникальным
-- индексом (admin_sessions_token_key / user_sessions_token_key,
-- созданным `@unique` в schema.prisma) — отдельный обычный индекс на ту
-- же колонку избыточен, Postgres и так использует уникальный индекс
-- для поиска. Написано вручную по тем же причинам, что и предыдущие
-- миграции (см. doc/TELEGRAM-ADMIN.md, §5) — проверено применением к
-- реальному локальному Postgres 16, см. doc/DATABASE-AUDIT.md.

-- DropIndex
DROP INDEX "admin_sessions_token_idx";

-- DropIndex
DROP INDEX "user_sessions_token_idx";
