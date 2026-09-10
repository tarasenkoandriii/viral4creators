-- Этап 40 (раздел I.4 аудита): индексы под реальные запросы и разведение
-- двух смыслов у `ai_usage.userId IS NULL`.
--
-- Все числа ниже измерены на засеянной копии схемы (300 тыс. сессий,
-- 800 тыс. строк расхода, 60 тыс. записей библиотеки), а не оценены.

-- 1. Уборка истёкших входов ходит по expiresAt. Индекса не было, и она
--    сканировала таблицу целиком — не только по расписанию, но и внутри
--    КАЖДОГО входа, где удалять чаще всего нечего (22,9 мс со строками
--    на удаление, 3,3 мс без них, на 60 тыс. строк).
CREATE INDEX "user_sessions_expiresAt_idx" ON "user_sessions"("expiresAt");
CREATE INDEX "admin_sessions_expiresAt_idx" ON "admin_sessions"("expiresAt");

-- 2. Рекомендации библиотеки (§21.2): фильтр по видимости + сортировка по
--    популярности. Без составного индекса Postgres поднимал с диска ВСЕ
--    публичные строки и делал top-N heapsort — 11,1 мс против 0,32 мс,
--    в 35 раз. Порядок колонок повторяет порядок в запросе.
CREATE INDEX "analysis_library_visibility_usageCount_createdAt_idx"
  ON "analysis_library"("visibility", "usageCount" DESC, "createdAt" DESC);

-- 3. Три индекса, под которые нет ни одного запроса. Это не поломка, а
--    налог: 5 МБ на 800 тыс. строк и замедление КАЖДОЙ вставки в журнал
--    расходов — самого горячего пути записи в проекте.
--
--    `provider` встречается только в groupBy по всей таблице без where
--    (план его не берёт); `audienceGender` вообще не доходит до SQL —
--    ранжирование по аудитории делает JS после выборки; `category`
--    используется как ILIKE '%q%', который btree обслужить не может.
--
--    Индексы по FK-колонкам не трогаем: они обслуживают проверку внешних
--    ключей при удалении родителя, даже когда своего `where` у них нет.
DROP INDEX "ai_usage_provider_idx";
DROP INDEX "analysis_library_category_idx";
DROP INDEX "analysis_library_audienceGender_idx";

-- 4. `ai_usage.userId IS NULL` означало две разные вещи: «вызов был
--    анонимным» и «аккаунт удалили» (onDelete: SetNull). Из-за второго
--    расход удалённого пользователя мгновенно перетекал в ОБЩИЙ суточный
--    потолок анонимных и выбивал его для всех остальных.
--
--    Существующие строки размечаем по текущему владельцу — другого
--    источника истины для них нет, и на момент миграции он верен.
ALTER TABLE "ai_usage" ADD COLUMN "anonymous" BOOLEAN NOT NULL DEFAULT false;
UPDATE "ai_usage" SET "anonymous" = true WHERE "userId" IS NULL;

-- Суточный потолок анонимных читает пару (anonymous, createdAt).
CREATE INDEX "ai_usage_anonymous_createdAt_idx" ON "ai_usage"("anonymous", "createdAt");

-- 5. Каталог удалённого пользователя больше не остаётся призраком
--    (А-1.11). `SetNull` оставлял проекты и манифесты с `userId = NULL`:
--    они не «общие», а недостижимые НИ ОДНИМ запросом — все выборки идут
--    по владельцу, — и вместе с ними в хранилище навсегда оставались фото
--    товаров и персонажей, которые метла не подбирает (она ходит только
--    по префиксу `sessions/`).
--
--    Библиотека разборов — сознательное исключение: там `SetNull`
--    остаётся, потому что разборы принадлежат сервису (§4 условий) и
--    обязаны пережить автора. Сессии тоже: на их ролики может ссылаться
--    заявка на публикацию.
ALTER TABLE "projects" DROP CONSTRAINT "projects_userId_fkey";
ALTER TABLE "projects" ADD CONSTRAINT "projects_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "brand_manifests" DROP CONSTRAINT "brand_manifests_userId_fkey";
ALTER TABLE "brand_manifests" ADD CONSTRAINT "brand_manifests_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
