-- Шестой аудит, Е-5.1: `users` — самая крупная и быстрее всего растущая
-- таблица проекта, не имела ни одного индекса, кроме unique на
-- telegramId. `AdminUsersService.list()` — дефолтный вид вкладки
-- «Пользователи» (самый частый экран оператора) — без фильтров
-- сортирует orderBy: {createdAt: 'desc'} по всей таблице (Seq Scan +
-- Sort); фильтры plan/isOperator/isBlocked читают её же целиком; поиск —
-- тройной ILIKE '%q%' по telegramId/username/firstName — тоже без
-- индекса.
--
-- Этап 54 (В-4.9, миграция rate_limits_plan_origin_trgm) сознательно НЕ
-- завёл триграммные индексы здесь же, где для analysis_library — на
-- тогдашнем размере (тысячи строк) Seq Scan обгонял индекс. К шестому
-- аудиту таблица выросла настолько, что то же решение больше не верно —
-- тот же класс поиска по подстроке, что уже закрыт GIN-триграммами для
-- analysis_library.
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- pg_trgm уже создано миграцией rate_limits_plan_origin_trgm (этап 54),
-- но CREATE EXTENSION IF NOT EXISTS идемпотентен — не вредит повторить.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE INDEX "users_telegramId_trgm_idx" ON "users" USING GIN ("telegramId" gin_trgm_ops);
CREATE INDEX "users_username_trgm_idx" ON "users" USING GIN ("username" gin_trgm_ops);
CREATE INDEX "users_firstName_trgm_idx" ON "users" USING GIN ("firstName" gin_trgm_ops);
